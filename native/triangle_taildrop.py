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
"""

import json
import os
import struct
import subprocess
import sys

# The CLI ships in different places depending on how Tailscale was installed.
# The Mac App Store build is sandboxed and does not expose `file cp`, so the
# standalone app / Homebrew build is required — we report that clearly.
CANDIDATES = [
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/usr/bin/tailscale",
    "/usr/sbin/tailscale",
]


def find_tailscale():
    for p in CANDIDATES:
        if os.path.isfile(p) and os.access(p, os.X_OK):
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
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout,
                          stdin=subprocess.DEVNULL)


def cmd_ping(ts):
    r = run([ts, "version"], timeout=15)
    return {"ok": True, "tailscale": ts, "version": (r.stdout or "").strip().splitlines()[:1]}


def cmd_devices(ts):
    r = run([ts, "status", "--json"], timeout=20)
    if r.returncode != 0:
        return {"ok": False, "error": (r.stderr or "tailscale status failed").strip()}
    st = json.loads(r.stdout)
    me = st.get("Self") or {}
    my_user = me.get("UserID")
    devices = []
    for peer in (st.get("Peer") or {}).values():
        # Taildrop only works between devices owned by the same user
        if my_user is not None and peer.get("UserID") != my_user:
            continue
        dns = (peer.get("DNSName") or "").rstrip(".")
        host = peer.get("HostName") or dns.split(".")[0]
        devices.append({
            "name": host,
            "host": dns.split(".")[0] or host,
            "online": bool(peer.get("Online")),
            "self": False,
        })
    devices.sort(key=lambda d: (not d["online"], d["name"].lower()))
    return {"ok": True, "devices": devices, "self": me.get("HostName")}


def cmd_send(ts, msg):
    path = msg.get("path") or ""
    target = (msg.get("target") or "").strip()
    if not path or not target:
        return {"ok": False, "error": "не указан файл или устройство"}

    real = os.path.realpath(os.path.expanduser(path))
    home = os.path.realpath(os.path.expanduser("~"))
    if not real.startswith(home + os.sep):
        return {"ok": False, "error": "путь вне домашней папки — отклонено"}
    if not os.path.isfile(real):
        return {"ok": False, "error": "файл не найден: " + real}

    # target must be a real peer, never a free-form string
    known = cmd_devices(ts)
    if not known.get("ok"):
        return known
    names = {d["host"] for d in known["devices"]} | {d["name"] for d in known["devices"]}
    if target not in names:
        return {"ok": False, "error": "устройство не найдено в сети: " + target}

    r = run([ts, "file", "cp", real, target + ":"], timeout=3600)
    if r.returncode != 0:
        err = (r.stderr or r.stdout or "").strip() or ("код " + str(r.returncode))
        return {"ok": False, "error": err}
    return {"ok": True, "sent": os.path.basename(real), "target": target}


# ---- SMB -------------------------------------------------------------------
# Mounting requires credentials, which this helper deliberately never handles:
# mount the share once in Finder (⌘K) and it shows up here as a normal folder
# under /Volumes. Discovery is Bonjour-only and just tells you what exists.

def cmd_smb_mounted():
    """SMB shares already mounted on this Mac."""
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
        free_mb = None
        try:
            st = os.statvfs(mnt)
            free_mb = int(st.f_bavail * st.f_frsize / (1024 * 1024))
        except Exception:
            pass
        out.append({
            "path": mnt,
            "name": os.path.basename(mnt.rstrip("/")) or mnt,
            "url": src,
            "freeMb": free_mb,
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


def cmd_smb_discover(seconds=4):
    """Bonjour browse for SMB servers on the local network."""
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
    host = (msg.get("host") or "").strip()
    if not host:
        return {"ok": False, "error": "не указан сервер"}
    if not all(c.isalnum() or c in ".-_" for c in host):
        return {"ok": False, "error": "недопустимое имя сервера"}
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


def cmd_smb_save(msg):
    """Copy an already-downloaded file into a mounted SMB folder."""
    import shutil
    src = msg.get("path") or ""
    dst_dir = msg.get("dir") or ""
    if not src or not dst_dir:
        return {"ok": False, "error": "не указан файл или папка"}

    real = os.path.realpath(os.path.expanduser(src))
    home = os.path.realpath(os.path.expanduser("~"))
    if not real.startswith(home + os.sep):
        return {"ok": False, "error": "путь вне домашней папки — отклонено"}
    if not os.path.isfile(real):
        return {"ok": False, "error": "файл не найден: " + real}

    dst_real = os.path.realpath(os.path.expanduser(dst_dir))
    known = {m["path"] for m in cmd_smb_mounted()["mounted"]}
    if not any(dst_real == k or dst_real.startswith(k.rstrip("/") + os.sep) for k in known):
        return {"ok": False, "error": "папка не является смонтированной SMB-шарой: " + dst_real}
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
    src = msg.get("path") or ""
    host = (msg.get("host") or "").strip()
    if not src or not host:
        return {"ok": False, "error": "не указан файл или сервер"}
    if not all(c.isalnum() or c in ".-_" for c in host):
        return {"ok": False, "error": "недопустимое имя сервера"}

    real = os.path.realpath(os.path.expanduser(src))
    home = os.path.realpath(os.path.expanduser("~"))
    if not real.startswith(home + os.sep):
        return {"ok": False, "error": "путь вне домашней папки — отклонено"}
    if not os.path.isfile(real):
        return {"ok": False, "error": "файл не найден: " + real}

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
        r = run(["curl", "-sS", "--connect-timeout", "15", "--ftp-create-dirs",
                 "--config", cfgfile, "-T", real, url], timeout=3600)
    finally:
        try: os.unlink(cfgfile)
        except OSError: pass
    if r.returncode != 0:
        return {"ok": False, "error": (r.stderr or "").strip() or ("curl код " + str(r.returncode))}
    return {"ok": True, "sent": os.path.basename(real), "target": host}


def main():
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
                write_message({"ok": False, "error":
                               "не найден CLI tailscale — установите Tailscale с tailscale.com "
                               "(версия из App Store не умеет file cp)"})
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
            write_message({"ok": False, "error": "tailscale не ответил вовремя"})
        except Exception as e:
            write_message({"ok": False, "error": str(e)})


if __name__ == "__main__":
    main()
