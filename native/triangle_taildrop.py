#!/usr/bin/env python3
"""Triangle Downloader — Taildrop bridge (Chrome native messaging host).

A browser extension cannot reach Taildrop: sending goes through the tailscaled
daemon over a unix socket, which is unreachable from a page or a service worker.
So the extension saves the file normally, then hands the LOCAL PATH to this
helper, which shells out to the Tailscale CLI.

Protocol (Chrome native messaging): each message is a little-endian uint32 length
followed by that many bytes of UTF-8 JSON, on stdin/stdout.

Commands:
    {"cmd": "ping"}                          -> {"ok": true, "tailscale": "<path>", "version": "..."}
    {"cmd": "devices"}                       -> {"ok": true, "devices": [{name, host, online, self}]}
    {"cmd": "send", "path": "...", "target": "host"} -> {"ok": true} | {"ok": false, "error": "..."}

Only paths inside the user's home directory are accepted, and the target is
matched against the actual peer list — the extension never gets to pass an
arbitrary string to the shell (there is no shell: subprocess uses argv).

Runs on macOS/Linux and Windows. The two differ mostly in SMB: macOS mounts
shares under /Volumes and browses via Bonjour, Windows maps them to drive
letters (or takes \\\\server\\share directly) and has no Bonjour at all.
"""

import json
import os
import struct
import subprocess
import sys

IS_WIN = sys.platform == "win32"

# The CLI ships in different places depending on how Tailscale was installed.
# The Mac App Store build is sandboxed and does not expose `file cp`, so the
# standalone app / Homebrew build is required — we report that clearly.
if IS_WIN:
    CANDIDATES = [
        os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "Tailscale", "tailscale.exe"),
        os.path.join(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"), "Tailscale", "tailscale.exe"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Tailscale", "tailscale.exe"),
    ]
else:
    CANDIDATES = [
        "/usr/local/bin/tailscale",
        "/opt/homebrew/bin/tailscale",
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/usr/bin/tailscale",
        "/usr/sbin/tailscale",
    ]

NO_TAILSCALE = ("не найден CLI tailscale — установите Tailscale с tailscale.com"
                if IS_WIN else
                "не найден CLI tailscale — установите Tailscale с tailscale.com "
                "(версия из App Store не умеет file cp)")


def find_tailscale():
    for p in CANDIDATES:
        if p and os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    from shutil import which
    return which("tailscale")


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (length,) = struct.unpack("<I", raw)
    data = sys.stdin.buffer.read(length)
    return json.loads(data.decode("utf-8"))


def write_message(obj):
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def run(args, timeout=120):
    # stdin MUST be detached: our own stdin is the native-messaging channel, and a
    # child that decides to prompt (smbutil asks for a password without -N) would
    # eat framing bytes and wedge the protocol.
    #
    # encoding is explicit on purpose: without it Windows decodes child output
    # with the ANSI codepage, and `tailscale status --json` (always UTF-8) comes
    # back mangled — a device named «Телефон» stops matching the name the
    # extension sends back, and Taildrop reports it as offline.
    extra = {}
    if IS_WIN:
        # otherwise every helper call flashes a console window over the browser
        extra["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout,
                          stdin=subprocess.DEVNULL, encoding="utf-8", errors="replace",
                          **extra)


def run_console(args, timeout=120):
    """Same as run(), but for tools that speak the console codepage (net view).

    `net` predates UTF-8 and prints in the OEM codepage; decoding that as UTF-8
    turns every non-ASCII share name into replacement characters.
    """
    extra = {}
    if IS_WIN:
        extra["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
        import ctypes
        enc = "cp" + str(ctypes.windll.kernel32.GetConsoleOutputCP() or 866)
    else:
        enc = "utf-8"
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout,
                          stdin=subprocess.DEVNULL, encoding=enc, errors="replace",
                          **extra)


def _known_downloads():
    """The real Downloads folder, which is often moved off the system drive.

    Windows keeps it in the known-folder table rather than under the profile, so
    asking the OS is the only way to learn it; on macOS/Linux it lives in $HOME
    anyway and the plain path is enough.
    """
    if not IS_WIN:
        return os.path.expanduser("~/Downloads")
    try:
        import ctypes
        from ctypes import wintypes
        FOLDERID_Downloads = ctypes.create_string_buffer(
            b"\x90\xe2\x4d\x37\x3f\x12\x65\x45\x91\x64\x39\xc4\x92\x5e\x46\x7b")
        ptr = ctypes.c_wchar_p()
        if ctypes.windll.shell32.SHGetKnownFolderPath(
                ctypes.byref(FOLDERID_Downloads), 0, None, ctypes.byref(ptr)) == 0:
            path = ptr.value
            ctypes.windll.ole32.CoTaskMemFree(ptr)
            return path
    except Exception:
        pass
    return os.path.expanduser("~\\Downloads")


def _browser_download_dirs():
    """Download folders the user picked inside Chromium browsers themselves.

    Chrome's downloads often live on another drive entirely (E:\\Video) without
    any known-folder redirection. The browser records that choice in each
    profile's Preferences JSON — the authoritative place to learn it.
    """
    if not IS_WIN:
        return []
    base = os.environ.get("LOCALAPPDATA", "")
    if not base:
        return []
    out = []
    for vendor in (r"Google\Chrome", r"Microsoft\Edge",
                   r"BraveSoftware\Brave-Browser", "Chromium"):
        userdata = os.path.join(base, vendor, "User Data")
        try:
            profiles = os.listdir(userdata)
        except OSError:
            continue
        for prof in profiles:
            pref = os.path.join(userdata, prof, "Preferences")
            if not os.path.isfile(pref):
                continue
            try:
                with open(pref, encoding="utf-8") as fh:
                    d = (json.load(fh).get("download") or {}).get("default_directory")
            except Exception:
                continue
            if d and os.path.isdir(d) and d not in out:
                out.append(d)
    return out


def allowed_roots():
    """Folders this helper is willing to read files from.

    The home directory alone is not enough: a browser whose downloads live on
    another drive (D:\\Downloads) would have every send rejected. Hence also
    the known Downloads folder and every download directory configured in an
    installed Chromium browser.
    """
    roots = [os.path.expanduser("~")]
    dl = _known_downloads()
    if dl:
        roots.append(dl)
    roots.extend(_browser_download_dirs())
    return [os.path.realpath(r) for r in roots if r]


def under_home(path):
    """Resolved path if it sits inside an allowed root, else None.

    Windows paths are case-insensitive, so both sides are normalised before
    comparing — otherwise C:\\Users\\Name and c:\\users\\name look unrelated.
    """
    real = os.path.realpath(os.path.expanduser(path))
    low = os.path.normcase(real)
    for root in allowed_roots():
        r = os.path.normcase(root)
        if low == r or low.startswith(r.rstrip("\\/") + os.sep):
            return real
    return None


def outside_error(path):
    """Rejection message that actually says what was compared."""
    real = os.path.realpath(os.path.expanduser(path))
    return ("файл вне разрешённых папок — отклонено. Файл: " + real +
            "; разрешено: " + ", ".join(allowed_roots()))


def cmd_ping(ts):
    r = run([ts, "version"], timeout=15)
    return {"ok": True, "tailscale": ts, "version": (r.stdout or "").strip().splitlines()[:1]}


def _pretty_names(ts):
    """{tailscale IP: human name} from `status --json`.

    `file cp --targets` only prints the machine hostname (s20-fe), while the
    status output carries the name the owner actually gave the device
    ("S20 FE пользователя Даниил") — nicer to pick from a list.
    """
    names = {}
    try:
        r = run([ts, "status", "--json"], timeout=20)
        if r.returncode != 0:
            return names
        st = json.loads(r.stdout)
        for peer in (st.get("Peer") or {}).values():
            label = peer.get("HostName") or (peer.get("DNSName") or "").rstrip(".").split(".")[0]
            for ip in peer.get("TailscaleIPs") or []:
                names[ip] = label
    except Exception:
        pass
    return names


def cmd_devices(ts):
    """Devices that can actually receive a file.

    Tailscale answers this itself: `file cp --targets` lists exactly the peers
    Taildrop will accept (same owner, capable platform), one per line as
    "<ip>\\t<host>[\\toffline; last seen ...]". Deriving the same list from
    `status --json` by hand means re-implementing rules that belong to
    Tailscale.
    """
    r = run([ts, "file", "cp", "--targets"], timeout=20)
    if r.returncode != 0:
        err = (r.stderr or r.stdout or "").strip()
        return {"ok": False, "error": err or "tailscale не отдал список устройств"}

    pretty = _pretty_names(ts)
    devices = []
    for line in (r.stdout or "").splitlines():
        parts = line.rstrip().split("\t")
        if len(parts) < 2 or not parts[0]:
            continue
        ip, host = parts[0].strip(), parts[1].strip()
        note = parts[2].strip() if len(parts) > 2 else ""
        devices.append({
            "name": pretty.get(ip) or host,
            "host": host,
            # The address is what we send to: device names carry apostrophes and
            # non-ASCII and survive the trip through the browser far less
            # reliably than 100.x.y.z does.
            "ip": ip,
            "online": not note.lower().startswith("offline"),
            "note": note,
            "self": False,
        })
    devices.sort(key=lambda d: (not d["online"], d["name"].lower()))
    return {"ok": True, "devices": devices}


def cmd_send(ts, msg):
    path = msg.get("path") or ""
    target = (msg.get("target") or "").strip()
    if not path or not target:
        return {"ok": False, "error": "не указан файл или устройство"}

    real = under_home(path)
    if not real:
        return {"ok": False, "error": outside_error(path)}
    if not os.path.isfile(real):
        return {"ok": False, "error": "файл не найден: " + real}

    # target must be a real peer, never a free-form string; it may arrive as an
    # address or as a name (older settings), but we always send to the address
    known = cmd_devices(ts)
    if not known.get("ok"):
        return known
    peer = next((d for d in known["devices"]
                 if target in (d.get("ip"), d.get("host"), d.get("name")) and target), None)
    if not peer:
        return {"ok": False, "error": "устройство не принимает файлы или не в вашей сети: " + target}
    if not peer.get("online"):
        return {"ok": False, "error": "устройство не в сети: " + peer["name"] +
                (" (" + peer["note"] + ")" if peer.get("note") else "")}
    addr = peer.get("ip") or peer.get("host") or target

    r = run([ts, "file", "cp", real, addr + ":"], timeout=3600)
    if r.returncode != 0:
        err = (r.stderr or r.stdout or "").strip() or ("код " + str(r.returncode))
        return {"ok": False, "error": err}
    return {"ok": True, "sent": os.path.basename(real), "target": target}


# ---- SMB -------------------------------------------------------------------
# Mounting requires credentials, which this helper deliberately never handles:
# connect the share once in Finder (⌘K) or Explorer, and it shows up here as a
# normal folder. Discovery just tells you what exists on the network.

def _free_mb(path):
    try:
        import shutil
        return int(shutil.disk_usage(path).free / (1024 * 1024))
    except Exception:
        return None


def _win_network_drives():
    """Mapped network drives, read from the OS rather than parsed out of `net use`.

    `net use` prints localised column headers ("OK" vs "ОК"), so its output is
    not safe to parse; GetDriveType/WNetGetConnection answer the same question
    in any locale.
    """
    import ctypes
    from ctypes import wintypes
    DRIVE_REMOTE = 4
    k32 = ctypes.windll.kernel32
    mpr = ctypes.windll.mpr
    out = []
    mask = k32.GetLogicalDrives()
    for i in range(26):
        if not (mask >> i) & 1:
            continue
        letter = chr(ord("A") + i) + ":"
        if k32.GetDriveTypeW(letter + "\\") != DRIVE_REMOTE:
            continue
        unc = ""
        buf = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(len(buf))
        if mpr.WNetGetConnectionW(letter, buf, ctypes.byref(size)) == 0:
            unc = buf.value
        out.append({
            "path": letter + "\\",
            "name": (unc.rstrip("\\").split("\\")[-1] if unc else letter),
            "url": unc or letter,
            "freeMb": _free_mb(letter + "\\"),
            "writable": os.access(letter + "\\", os.W_OK),
        })
    return out


def cmd_smb_mounted():
    """SMB shares currently available as folders on this machine."""
    if IS_WIN:
        out = _win_network_drives()
        out.sort(key=lambda d: d["name"].lower())
        return {"ok": True, "mounted": out,
                "hint": "можно указать и путь вида \\\\сервер\\шара — подключать диск необязательно"}

    r = run(["/sbin/mount"], timeout=10)
    out = []
    for line in (r.stdout or "").splitlines():
        # //user@server/share on /Volumes/share (smbfs, nodev, nosuid, ...)
        if "smbfs" not in line or " on " not in line:
            continue
        try:
            src, rest = line.split(" on ", 1)
            mnt = rest.rsplit(" (", 1)[0]
        except ValueError:
            continue
        out.append({
            "path": mnt,
            "name": os.path.basename(mnt.rstrip("/")) or mnt,
            "url": src,
            "freeMb": _free_mb(mnt),
            "writable": os.access(mnt, os.W_OK),
        })
    out.sort(key=lambda d: d["name"].lower())
    return {"ok": True, "mounted": out}


def _browse(args, seconds):
    """dns-sd runs until killed — start it, let it collect, then stop."""
    import time
    try:
        p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             stdin=subprocess.DEVNULL, text=True)
    except FileNotFoundError:
        return ""
    time.sleep(seconds)
    p.terminate()
    try:
        out, _ = p.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        p.kill()
        out, _ = p.communicate()
    return out or ""


def _win_unc_lines(text):
    """UNC names out of `net view` output — the only locale-proof part of it."""
    names = []
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("\\\\"):
            continue
        name = line.split()[0].lstrip("\\")
        if name and name not in names:
            names.append(name)
    return names


def cmd_smb_discover(seconds=4):
    """Look for SMB servers on the local network."""
    if IS_WIN:
        # Bonjour does not exist here; `net view` relies on the Computer Browser
        # service, which modern Windows often has disabled — it then hangs until
        # it gives up. An empty list is the normal outcome, not an error, hence
        # the short timeout and the hint about typing the path by hand.
        servers = []
        try:
            r = run_console(["net", "view"], timeout=10)
            servers = [{"name": n, "host": n} for n in _win_unc_lines(r.stdout or "")]
        except subprocess.TimeoutExpired:
            pass
        return {"ok": True, "servers": servers,
                "hint": "если список пуст, введите путь вручную: \\\\сервер\\шара"}

    text = _browse(["/usr/bin/dns-sd", "-B", "_smb._tcp", "local."], seconds)
    names = []
    for line in text.splitlines():
        parts = line.split()
        # Timestamp A/R Flags if Domain Service-Type Instance-Name...
        if len(parts) >= 7 and parts[1] == "Add" and parts[5].startswith("_smb"):
            name = " ".join(parts[6:]).strip()
            if name and name not in names:
                names.append(name)

    servers = []
    for name in names[:8]:  # resolving is another wait each, keep it bounded
        host = None
        res = _browse(["/usr/bin/dns-sd", "-L", name, "_smb._tcp", "local."], 2)
        for line in res.splitlines():
            if "can be reached at" in line:
                tail = line.split("can be reached at", 1)[1].strip()
                host = tail.split(":")[0].strip().rstrip(".")
                break
        servers.append({"name": name, "host": host})
    return {"ok": True, "servers": servers, "hint": "смонтируйте нужную шару в Finder (⌘K), "
                                                    "после этого она появится в списке папок"}


def cmd_smb_shares(msg):
    """List share names exported by a server (guest browse; may need auth)."""
    host = (msg.get("host") or "").strip().strip("\\")
    if not host:
        return {"ok": False, "error": "не указан сервер"}
    if not all(c.isalnum() or c in ".-_" for c in host):
        return {"ok": False, "error": "недопустимое имя сервера"}

    if IS_WIN:
        try:
            r = run_console(["net", "view", "\\\\" + host], timeout=15)
        except subprocess.TimeoutExpired:
            return {"ok": False, "error": "сервер не ответил — откройте \\\\" + host + " в проводнике"}
        if r.returncode != 0:
            return {"ok": False, "error": (r.stderr or r.stdout or "").strip() or
                    "не удалось получить список — вероятно, нужен вход; "
                    "откройте \\\\" + host + " в проводнике"}
        # Column headers are localised; the share name is always the first token
        # of the rows between the dashed separator and the trailing status line.
        shares, started = [], False
        for line in (r.stdout or "").splitlines():
            if set(line.strip()) == {"-"}:
                started = True
                continue
            if not started:
                continue
            parts = line.split()
            if len(parts) >= 2 and not line.startswith(" "):
                shares.append(parts[0])
        return {"ok": True, "host": host, "shares": shares}

    # -N: never prompt for a password. Guest flag spelling differs between macOS
    # releases, so try the guest form first and fall back to plain -N.
    r = None
    for flags in (["-N", "-g"], ["-N"]):
        r = run(["/usr/bin/smbutil", "view"] + flags + ["//" + host], timeout=20)
        if r.returncode == 0:
            break
    if r.returncode != 0:
        return {"ok": False, "error": (r.stderr or r.stdout or "").strip() or
                "не удалось получить список — вероятно, нужен вход, смонтируйте шару в Finder"}
    shares = []
    for line in (r.stdout or "").splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[1].lower() in ("disk", "диск"):
            shares.append(parts[0])
    return {"ok": True, "host": host, "shares": shares}


def _is_network_target(dst_real):
    """True if the folder is a network location we are willing to write into."""
    if IS_WIN and dst_real.startswith("\\\\"):
        return True  # UNC path — network by definition, no mapping needed
    known = {m["path"] for m in cmd_smb_mounted()["mounted"]}
    return any(os.path.normcase(dst_real) == os.path.normcase(k) or
               os.path.normcase(dst_real).startswith(os.path.normcase(k.rstrip("/\\")) + os.sep)
               for k in known)


def cmd_smb_save(msg):
    """Copy an already-downloaded file into a network folder."""
    import shutil
    src = msg.get("path") or ""
    dst_dir = msg.get("dir") or ""
    if not src or not dst_dir:
        return {"ok": False, "error": "не указан файл или папка"}

    real = under_home(src)
    if not real:
        return {"ok": False, "error": outside_error(src)}
    if not os.path.isfile(real):
        return {"ok": False, "error": "файл не найден: " + real}

    # realpath would resolve a UNC path into something os.path can't compare
    dst_real = os.path.abspath(os.path.expanduser(dst_dir)) if dst_dir.startswith("\\\\") \
        else os.path.realpath(os.path.expanduser(dst_dir))
    if not _is_network_target(dst_real):
        return {"ok": False, "error": "папка не является сетевой шарой: " + dst_real}
    if not os.path.isdir(dst_real):
        return {"ok": False, "error": "папка недоступна: " + dst_real}
    if not os.access(dst_real, os.W_OK):
        return {"ok": False, "error": "нет прав на запись: " + dst_real}

    target = os.path.join(dst_real, os.path.basename(real))
    base, ext = os.path.splitext(target)
    n = 1
    while os.path.exists(target):       # never silently overwrite
        target = base + " (" + str(n) + ")" + ext
        n += 1
    try:
        shutil.copyfile(real, target)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "saved": target}


def cmd_ftp_put(msg):
    """Upload a downloaded file over FTP via curl. Credentials go through a
    0600 temp config file, never through argv (argv is visible in `ps`)."""
    import tempfile
    from shutil import which
    src = msg.get("path") or ""
    host = (msg.get("host") or "").strip()
    if not src or not host:
        return {"ok": False, "error": "не указан файл или сервер"}
    if not all(c.isalnum() or c in ".-_" for c in host):
        return {"ok": False, "error": "недопустимое имя сервера"}

    real = under_home(src)
    if not real:
        return {"ok": False, "error": outside_error(src)}
    if not os.path.isfile(real):
        return {"ok": False, "error": "файл не найден: " + real}

    curl = which("curl")
    if not curl:
        return {"ok": False, "error": "не найден curl (в Windows входит в состав системы с 2018 года)"}

    port = int(msg.get("port") or 21)
    dirpath = "/".join(p for p in str(msg.get("dir") or "").split("/") if p and p != "..")
    url = "ftp://%s:%d/%s%s" % (host, port, dirpath + "/" if dirpath else "",
                                os.path.basename(real))

    user = msg.get("user") or "anonymous"
    password = msg.get("pass") or ""
    q = lambda s: str(s).replace("\\", "\\\\").replace('"', '\\"')
    fd, cfgfile = tempfile.mkstemp(prefix="ytdl-ftp-")
    try:
        os.write(fd, ('user = "%s:%s"\n' % (q(user), q(password))).encode())
        os.close(fd)
        r = run([curl, "-sS", "--connect-timeout", "15", "--ftp-create-dirs",
                 "--config", cfgfile, "-T", real, url], timeout=3600)
    finally:
        try: os.unlink(cfgfile)
        except OSError: pass
    if r.returncode != 0:
        return {"ok": False, "error": (r.stderr or "").strip() or ("curl код " + str(r.returncode))}
    return {"ok": True, "sent": os.path.basename(real), "target": host}


def main():
    if IS_WIN:
        # Windows would translate \n into \r\n on the way out and corrupt the
        # length-prefixed framing.
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)

    ts = find_tailscale()
    while True:
        try:
            msg = read_message()
        except Exception as e:
            write_message({"ok": False, "error": "плохое сообщение: " + str(e)})
            return
        if msg is None:
            return
        try:
            cmd = msg.get("cmd")
            # SMB commands do not need Tailscale at all
            if cmd == "smb-mounted":
                write_message(cmd_smb_mounted()); continue
            if cmd == "smb-discover":
                write_message(cmd_smb_discover(int(msg.get("seconds") or 4))); continue
            if cmd == "smb-shares":
                write_message(cmd_smb_shares(msg)); continue
            if cmd == "smb-save":
                write_message(cmd_smb_save(msg)); continue
            if cmd == "ftp-put":
                write_message(cmd_ftp_put(msg)); continue

            if not ts:
                write_message({"ok": False, "error": NO_TAILSCALE})
                continue
            if cmd == "ping":
                write_message(cmd_ping(ts))
            elif cmd == "devices":
                write_message(cmd_devices(ts))
            elif cmd == "send":
                write_message(cmd_send(ts, msg))
            else:
                write_message({"ok": False, "error": "неизвестная команда: " + str(cmd)})
        except subprocess.TimeoutExpired:
            write_message({"ok": False, "error": "внешняя команда не ответила вовремя"})
        except Exception as e:
            write_message({"ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
