#!/usr/bin/env python3
"""Local-overhead benchmark: interactive TUI vs headless Claude Code.

Answers "is there a resource benefit to running agents headless?" by isolating
the LOCAL cost of the agent harness (model round-trips are identical and
network-bound, so they are not the signal). Per claude process, via os.wait4
rusage, we capture:

  - wall clock (s)
  - user CPU (s) + system CPU (s)   -> local compute: Ink render loop, parsing
  - peak RSS (MB)                    -> per-instance memory footprint

Experiments:
  A. headless active task   claude -p <task> --output-format json
  B. TUI active task        claude (interactive) driven over a real pty
  C. TUI idle pane          open a pane, sit at the prompt, do nothing
  D. TUI marginal idle/sec  (long-hold CPU - startup CPU) / elapsed
  E. parallel headless      N concurrent headless runs; wall + memory scaling

CAVEAT: the pty "terminal" here is a Python reader, NOT a GPU terminal emulator.
Real interactive use adds iTerm/VS Code/Terminal repaint cost on every streamed
token, which this harness does NOT capture -> the TUI numbers below are a LOWER
BOUND on real-world interactive overhead.

Usage:
  python3 bench/tty-vs-headless.py            # full run, 4 iters, haiku
  ITERS=6 MODEL=haiku python3 bench/tty-vs-headless.py
  PARALLEL=1,4,8,16 python3 bench/tty-vs-headless.py

Each iteration makes one real model call (~$0.05 on haiku with the injected
system prompt), so a default full run is roughly $0.5-1.0 of API spend.
Results are also written to bench/tty-vs-headless.results.json.
"""
import os
import pty
import time
import select
import json
import tempfile
import statistics

MODEL = os.environ.get("MODEL", "haiku")
ITERS = int(os.environ.get("ITERS", "4"))
PARALLEL = [int(x) for x in os.environ.get("PARALLEL", "1,4,8").split(",")]
TASK = "Print the integers from 1 to 60, one per line, with no other commentary."
HERE = os.path.dirname(os.path.abspath(__file__))


def _rusage(ru, wall, extra=None):
    d = dict(
        wall_s=round(wall, 3),
        user_cpu_s=round(ru.ru_utime, 3),
        sys_cpu_s=round(ru.ru_stime, 3),
        cpu_s=round(ru.ru_utime + ru.ru_stime, 3),
        max_rss_mb=round(ru.ru_maxrss / 1024.0, 1),
    )
    if extra:
        d.update(extra)
    return d


def run_headless():
    tf = tempfile.NamedTemporaryFile(delete=False, suffix=".json")
    tf.close()
    t0 = time.time()
    pid = os.fork()
    if pid == 0:
        os.dup2(os.open("/dev/null", os.O_RDONLY), 0)
        fout = os.open(tf.name, os.O_WRONLY | os.O_TRUNC)
        os.dup2(fout, 1)
        os.dup2(fout, 2)
        os.execvp("claude", ["claude", "-p", TASK, "--model", MODEL, "--output-format", "json"])
        os._exit(127)
    _, _, ru = os.wait4(pid, 0)
    wall = time.time() - t0
    api = dur = None
    try:
        with open(tf.name) as f:
            j = json.load(f)
        api, dur = j.get("duration_api_ms"), j.get("duration_ms")
    except Exception:
        pass
    os.unlink(tf.name)
    return _rusage(ru, wall, {"api_ms": api, "self_dur_ms": dur})


def drive_pty(send_prompt, hold_s):
    """Fork claude under a pty. If send_prompt: submit TASK after a warmup and
    wait for the response to settle. Else: sit idle for hold_s."""
    t0 = time.time()
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp("claude", ["claude", "--model", MODEL])
        os._exit(127)
    WARMUP, IDLE_GAP, HARD_CAP = 3.0, 4.0, 45.0
    sent = False
    bytes_after_send = 0
    last_data = t0
    while True:
        el = time.time() - t0
        if send_prompt and not sent and el > WARMUP:
            os.write(fd, (TASK + "\r").encode())
            sent = True
            last_data = time.time()
        r, _, _ = select.select([fd], [], [], 0.3)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            last_data = time.time()
            if sent:
                bytes_after_send += len(data)
        now = time.time()
        if send_prompt:
            if sent and bytes_after_send > 200 and (now - last_data) > IDLE_GAP:
                break
            if el > HARD_CAP:
                break
        elif el > hold_s:
            break
    try:
        os.write(fd, b"/exit\r")
        time.sleep(0.5)
        os.kill(pid, 9)
    except (OSError, ProcessLookupError):
        pass
    _, _, ru = os.wait4(pid, 0)
    return _rusage(ru, time.time() - t0, {"bytes_streamed": bytes_after_send})


def parallel_headless(n):
    t0 = time.time()
    kids = []
    for _ in range(n):
        tf = tempfile.NamedTemporaryFile(delete=False, suffix=".json")
        tf.close()
        pid = os.fork()
        if pid == 0:
            os.dup2(os.open("/dev/null", os.O_RDONLY), 0)
            fout = os.open(tf.name, os.O_WRONLY | os.O_TRUNC)
            os.dup2(fout, 1)
            os.dup2(fout, 2)
            os.execvp("claude", ["claude", "-p", TASK, "--model", MODEL, "--output-format", "json"])
            os._exit(127)
        kids.append((pid, tf.name))
    per = []
    for pid, fname in kids:
        _, _, ru = os.wait4(pid, 0)
        api = None
        try:
            with open(fname) as f:
                api = json.load(f).get("duration_api_ms")
        except Exception:
            pass
        os.unlink(fname)
        per.append(dict(cpu=round(ru.ru_utime + ru.ru_stime, 2),
                        rss_mb=round(ru.ru_maxrss / 1024.0, 1), api_ms=api))
    return time.time() - t0, per


def _med(rows, key):
    vals = [r[key] for r in rows if isinstance(r.get(key), (int, float))]
    return statistics.median(vals) if vals else 0.0


def main():
    u = os.uname()
    ncpu = os.cpu_count()
    print(f"# Claude Code: TUI(PTY) vs headless | model={MODEL} iters={ITERS}")
    print(f"# host={u.nodename} {u.machine} cores={ncpu}")
    results = {"host": u.nodename, "machine": u.machine, "cores": ncpu, "model": MODEL}

    print("\n[A] headless active task ...", flush=True)
    head = []
    for i in range(ITERS):
        r = run_headless()
        head.append(r)
        print(f"  {i+1}: wall={r['wall_s']}s cpu={r['cpu_s']}s rss={r['max_rss_mb']}MB api={r['api_ms']}ms", flush=True)

    print("\n[B] TUI active task ...", flush=True)
    tui = []
    for i in range(ITERS):
        r = drive_pty(True, 0)
        tui.append(r)
        print(f"  {i+1}: wall={r['wall_s']}s cpu={r['cpu_s']}s rss={r['max_rss_mb']}MB", flush=True)

    print("\n[C/D] TUI idle + marginal idle CPU/sec ...", flush=True)
    short = [drive_pty(False, 4.0) for _ in range(2)]
    long = [drive_pty(False, 34.0) for _ in range(2)]
    s_cpu, l_cpu = _med(short, "cpu_s"), _med(long, "cpu_s")
    s_w, l_w = _med(short, "wall_s"), _med(long, "wall_s")
    marginal = (l_cpu - s_cpu) / (l_w - s_w) if l_w > s_w else 0.0
    print(f"  startup(~{s_w:.0f}s) cpu={s_cpu:.2f}s  long(~{l_w:.0f}s) cpu={l_cpu:.2f}s")
    print(f"  => marginal idle = {marginal*100:.1f}% of one core per open pane")

    print("\n[E] parallel headless scaling ...", flush=True)
    par = {}
    for n in PARALLEL:
        wall, rows = parallel_headless(n)
        apis = [p["api_ms"] for p in rows if p["api_ms"]]
        rss = [p["rss_mb"] for p in rows]
        par[str(n)] = dict(wall=round(wall, 2), per=rows)
        print(f"  N={n:2}: wall={wall:5.2f}s median_api={statistics.median(apis) if apis else 0:.0f}ms "
              f"total_rss~={sum(rss):.0f}MB", flush=True)

    head_cpu, tui_cpu = _med(head, "cpu_s"), _med(tui, "cpu_s")
    head_rss, tui_rss = _med(head, "max_rss_mb"), _med(tui, "max_rss_mb")
    print("\n=== summary (medians) ===")
    print(f"  CPU/task : headless {head_cpu:.2f}s  vs  TUI {tui_cpu:.2f}s   (TUI {tui_cpu/head_cpu:.1f}x)")
    print(f"  RSS/inst : headless {head_rss:.0f}MB vs  TUI {tui_rss:.0f}MB  (TUI +{tui_rss-head_rss:.0f}MB)")
    print(f"  TUI idle : {marginal*100:.1f}% core/pane steady-state")

    results.update(headless_active=head, tui_active=tui,
                   tui_idle_short=short, tui_idle_long=long,
                   marginal_idle_core_frac=marginal, parallel=par)
    out = os.path.join(HERE, "tty-vs-headless.results.json")
    with open(out, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\nraw -> {out}")


if __name__ == "__main__":
    main()
