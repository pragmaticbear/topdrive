"""Supervisor for the live topdrive demo: answers trust/update/permission prompts in the seats' tmux panes.

Only commands matching SAFE are approved; everything else is denied. Usage: python3 drive.py [seconds]
Set TMUX_SOCKET to target a non-default tmux server (e.g. /private/tmp/tmux-501/default).
"""
import os, re, subprocess, sys, time

SESS = ["dev-pln@tdrun", "dev-sol@tdrun", "dev-bld@tdrun"]
SAFE = [
    r"^rig\s",
    r"^cat\s+/tmp/hello\.txt\s*$",
    r"^(echo|printf)\b.*>\s*/tmp/hello\.txt\s*$",
    r"^echo\b.*\|\s*tee\s+/tmp/hello\.txt\s*$",
    r"^ls\b.*/tmp",
]
TMUX = ["tmux"] + (["-S", os.environ["TMUX_SOCKET"]] if os.environ.get("TMUX_SOCKET") else [])


CHAINING = re.compile(r"[;&`]|\$\(|\|\|")


def safe(cmd):
    # one command only: no `;`, `&&`, `||`, backgrounding or substitution can smuggle a second one past SAFE
    # and the only redirect allowed is the demo's own output file
    redirects_elsewhere = ">" in re.sub(r">\s*/tmp/hello\.txt\s*$", "", cmd)
    return not CHAINING.search(cmd) and not redirects_elsewhere and any(re.search(p, cmd) for p in SAFE)


def cap(s):
    return subprocess.run(TMUX + ["capture-pane", "-p", "-t", s], capture_output=True, text=True).stdout


def keys(s, *k):
    subprocess.run(TMUX + ["send-keys", "-t", s, *k])


def main():
    duration = float(sys.argv[1]) if len(sys.argv) > 1 else 60.0
    start = time.time()
    log = []
    while time.time() - start < duration:
        for s in SESS:
            t = cap(s)
            if not t:
                continue
            at = round(time.time() - start)

            # 1. Codex update prompt
            if "Update available" in t and "Skip" in t:
                log.append((at, s, "codex", "SKIP_UPDATE"))
                keys(s, "Escape")
                time.sleep(0.5)

            # 2. Codex folder trust prompt
            elif "Trust this folder?" in t and "1. Trust and continue" in t:
                log.append((at, s, "codex", "TRUST_FOLDER"))
                keys(s, "1")
                time.sleep(0.3)
                keys(s, "Enter")
                time.sleep(0.5)

            # 3. agy permission prompt
            elif "Run this command?" in t and "1. Yes, run command" in t:
                m = re.search(r"Requesting permission for:\s*\n\s*(.+)", t)
                cmd = m.group(1).strip() if m else ""
                ok = safe(cmd)
                log.append((at, s, "agy", "APPROVE" if ok else "DENY", cmd[:100]))
                keys(s, "1" if ok else "4")
                time.sleep(0.5)
                keys(s, "Enter")

            # 4. agy folder trust prompt
            elif "Do you trust the contents of this project?" in t and "1. Yes" in t:
                log.append((at, s, "agy", "TRUST_PROJECT"))
                keys(s, "1")
                time.sleep(0.5)
                keys(s, "Enter")

            # 5. Codex generic permission prompt
            elif ("Do you want to proceed?" in t or "Run command?" in t) and "1. Yes" in t:
                m = re.search(r"(?:Bash command|Bash\()\s*\n?\s*(.+)", t)
                cmd = m.group(1).strip() if m else ""
                ok = safe(cmd)
                log.append((at, s, "codex", "APPROVE" if ok else "DENY", cmd[:100] or t[-200:].replace("\n", " ")))
                keys(s, "1" if ok else "2")
                time.sleep(0.5)
                keys(s, "Enter")

        time.sleep(1.5)

    for entry in log:
        print(entry)


if __name__ == "__main__":
    main()
