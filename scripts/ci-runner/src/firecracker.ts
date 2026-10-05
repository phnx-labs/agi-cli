import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { warmSnapshotPath, type CiLayout } from './paths';
import { assertMounts } from './isolation';

export interface VmMount {
  source: string;
  target: string;
  writable: boolean;
}

export interface VmRecord {
  id: string;
  snapshot: string;
  mounts: VmMount[];
  destroyed: boolean;
  started: boolean;
  binary: string;
  exitCode?: number;
}

export interface VmLaunch {
  command: string[];
  cwd: string;
  env: Record<string, string>;
}

export function resolveFirecrackerBin(): string {
  const fromEnv = process.env.FIRECRACKER_BIN;
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      throw new Error(`FIRECRACKER_BIN does not exist: ${fromEnv}`);
    }
    return fromEnv;
  }
  const which = Bun.which('firecracker');
  if (!which) {
    throw new Error('firecracker binary not found; refusing to execute untrusted code on the host');
  }
  return which;
}

/** Warm one-use Firecracker lifecycle. start() always execs the Firecracker binary (FIRECRACKER_BIN
 * or PATH); a missing binary or warm snapshot is a hard error, so jobs never fall through to the
 * controller host. */
export class FirecrackerPool {
  constructor(private readonly layout: CiLayout) {
    mkdirSync(warmSnapshotPath(layout), { recursive: true });
    const marker = join(warmSnapshotPath(layout), '.warm');
    if (!existsSync(marker)) writeFileSync(marker, 'warm-snapshot\n');
  }

  vmDir(id: string): string {
    return join(this.layout.snapshots, 'vms', id);
  }

  restore(id: string, mounts: VmMount[]): VmRecord {
    if (existsSync(this.vmDir(id))) {
      throw new Error(`Firecracker vm ${id} already exists; one-use ids cannot be restored twice`);
    }
    assertMounts(mounts.map((mount) => mount.source));
    for (const mount of mounts) {
      if (mount.target === '/cache' && mount.writable) {
        throw new Error('cache mounts must be read-only');
      }
    }
    const writable = mounts.filter((mount) => mount.writable);
    if (writable.length !== 1) {
      throw new Error('one-use vm must mount exactly one writable worktree');
    }
    const binary = resolveFirecrackerBin();
    mkdirSync(this.vmDir(id), { recursive: true });
    const record: VmRecord = {
      id,
      snapshot: warmSnapshotPath(this.layout),
      mounts,
      destroyed: false,
      started: false,
      binary,
    };
    writeFileSync(join(this.vmDir(id), 'vm.json'), JSON.stringify(record, null, 2));
    return record;
  }

  start(id: string, launch: VmLaunch): VmRecord {
    const record = this.read(id);
    if (record.destroyed) throw new Error(`cannot start destroyed vm ${id}`);
    if (record.started) throw new Error(`vm ${id} is one-use and already started`);
    const binary = resolveFirecrackerBin();
    const configPath = join(this.vmDir(id), 'config.json');
    writeFileSync(configPath, JSON.stringify({
      snapshot: record.snapshot,
      mounts: record.mounts,
      command: launch.command,
      cwd: launch.cwd,
      env: launch.env,
    }, null, 2));
    const sock = join(this.vmDir(id), 'firecracker.sock');
    const proc = Bun.spawnSync({
      cmd: [binary, '--config-file', configPath, '--api-sock', sock],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    record.started = true;
    record.binary = binary;
    record.exitCode = proc.exitCode ?? 1;
    writeFileSync(join(this.vmDir(id), 'vm.json'), JSON.stringify(record, null, 2));
    writeFileSync(join(this.vmDir(id), 'stdout.log'), Buffer.from(proc.stdout).toString('utf8'));
    writeFileSync(join(this.vmDir(id), 'stderr.log'), Buffer.from(proc.stderr).toString('utf8'));
    if (proc.exitCode === null) {
      throw new Error(`firecracker produced no exit code for vm ${id}`);
    }
    return record;
  }

  destroy(id: string): void {
    const dir = this.vmDir(id);
    if (!existsSync(dir)) return;
    rmSync(dir, { recursive: true, force: true });
  }

  read(id: string): VmRecord {
    const file = join(this.vmDir(id), 'vm.json');
    if (!existsSync(file)) throw new Error(`vm ${id} does not exist`);
    return JSON.parse(readFileSync(file, 'utf8')) as VmRecord;
  }

  exists(id: string): boolean {
    return existsSync(join(this.vmDir(id), 'vm.json'));
  }

  logs(id: string): { stdout: string; stderr: string } {
    const dir = this.vmDir(id);
    return {
      stdout: existsSync(join(dir, 'stdout.log')) ? readFileSync(join(dir, 'stdout.log'), 'utf8') : '',
      stderr: existsSync(join(dir, 'stderr.log')) ? readFileSync(join(dir, 'stderr.log'), 'utf8') : '',
    };
  }
}
