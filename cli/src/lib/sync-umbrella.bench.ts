import { describe, bench } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { planUmbrellaStages } from './sync-umbrella.js';
import {
  getAvailableResources,
  getActuallySyncedResources,
  getGlobalDefault,
  getNewResources,
  getProjectOnlyResources,
  getVersionHomePath,
  listInstalledVersions,
  syncResourcesToVersion,
} from './installations/versions.js';
import { listResources } from './resources.js';
import { buildManifest, isStale, loadManifest } from './staleness/index.js';
import { getDetector } from './staleness/registry.js';
import { clearLayerCache } from './staleness/layers.js';
import { parseHookManifest, registerHooksToSettings } from './hooks/install.js';

const cwd = process.cwd();

const installedClaude = listInstalledVersions('claude');
const writeTarget = installedClaude[0];

const detectorTarget = getGlobalDefault('claude') ?? writeTarget;

const hookManifest = parseHookManifest();

const manifestTarget = detectorTarget;
const storedManifest = manifestTarget ? loadManifest('claude', manifestTarget) : null;

const guardHitVersions = installedClaude.filter((v) => {
  const m = loadManifest('claude', v);
  return m !== null && !isStale(m, 'claude', v, cwd);
});

const writeTargetManifestPath = writeTarget
  ? path.join(getVersionHomePath('claude', writeTarget), '.sync-manifest.json')
  : null;
const writeTargetManifestBefore =
  writeTargetManifestPath && fs.existsSync(writeTargetManifestPath)
    ? fs.readFileSync(writeTargetManifestPath)
    : null;

describe('stage 0 -- planUmbrellaStages (sync-umbrella.ts:51): the only work the umbrella itself does', () => {
  bench('bare `agents sync` (fetchRepos + reconcile)', () => {
    planUmbrellaStages({});
  });

  bench('`agents sync --local` (reconcile only, the flag that skips straight to refresh)', () => {
    planUmbrellaStages({ local: true });
  });
});

describe.skipIf(!writeTarget)('stage 1 -- discovery: the name-set scan run once per refresh AND once per version', () => {
  bench('getAvailableResources(cwd) (versions.ts:224) -- refresh.ts:200 and again at versions.ts:2799', () => {
    getAvailableResources(cwd);
  });

  bench('listResources("skills") (resources.ts:184) -- called by resourceSourceMap, versions.ts:2674', () => {
    listResources('skills', cwd);
  });

  bench('listResources("commands") (resources.ts:184)', () => {
    listResources('commands', cwd);
  });

  bench('listResources("hooks") (resources.ts:184, the group-expanding branch at resources.ts:208)', () => {
    listResources('hooks', cwd);
  });

  bench('listResources("subagents") (resources.ts:184)', () => {
    listResources('subagents', cwd);
  });

  bench('the four listResources calls resourceSourceMap makes per pattern-derived sync (versions.ts:2838)', () => {
    for (const kind of ['commands', 'skills', 'hooks', 'subagents'] as const) {
      new Map(listResources(kind, cwd).map((r) => [r.name, r.source]));
    }
  });
});

describe.skipIf(!detectorTarget)('stage 1b -- refresh.ts:211-212 new-resource diff (computed per agent on BOTH paths)', () => {
  const available = getAvailableResources(cwd);

  bench(`getActuallySyncedResources + getNewResources (refresh.ts:211-212), claude@${detectorTarget} (the refresh.ts:205 defaultVer)`, () => {
    const synced = getActuallySyncedResources('claude', detectorTarget!);
    getNewResources(available, synced, getProjectOnlyResources());
  });
});

describe.skipIf(!detectorTarget)('stage 1c -- per-detector breakdown of getActuallySyncedResources (versions.ts:460-468)', () => {
  const ctx = { version: detectorTarget!, versionHome: getVersionHomePath('claude', detectorTarget!), cwd };
  const kinds = ['commands', 'skills', 'hooks', 'rules', 'mcp', 'permissions', 'subagents', 'plugins', 'workflows'] as const;

  for (const kind of kinds) {
    bench(`detector "${kind}" (staleness/detectors/${kind}.ts) .list()`, () => {
      getDetector(kind, 'claude')?.list(ctx);
    }, kind === 'skills' || kind === 'plugins' ? { time: 3000, iterations: 5 } : {});
  }
});

describe.skipIf(!storedManifest)('stage 2 -- staleness guard (versions.ts:2874-2875): steady-state `agents sync` on a current box', () => {
  bench('isStale (staleness/index.ts:122), warm layer cache -- 2nd..Nth version in one refresh', () => {
    isStale(storedManifest!, 'claude', manifestTarget!, cwd);
  });

  bench(
    'isStale, COLD layer cache (layers.ts:53 clearLayerCache) -- the first version in a fresh `agents sync` process',
    () => {
      isStale(storedManifest!, 'claude', manifestTarget!, cwd);
    },
    {
      setup: (_t: unknown, mode: 'warmup' | 'run') => {
        if (mode === 'run') clearLayerCache();
      },
      iterations: 1,
      time: 1,
      warmupIterations: 0,
      warmupTime: 0,
    },
  );

  bench('loadManifest (staleness/index.ts:66) -- the JSON read in front of every guard', () => {
    loadManifest('claude', manifestTarget!);
  });
});

describe.skipIf(!writeTarget)('stage 4 -- buildManifest (staleness/index.ts:89): sha256 of every source, written after EVERY full sync', () => {
  bench('buildManifest (versions.ts:3262 buildSyncManifest) -- fingerprintFile/fingerprintDir over all layers', () => {
    buildManifest('claude', writeTarget!, cwd);
  });
});

describe.skipIf(!writeTarget)('stage 3 -- syncResourcesToVersion (versions.ts:2777): the real translation into agent-native format', () => {
  bench(
    'full sync, force:true (refresh.ts:247 forceFullSync) -- writers + orphan sweeps + buildManifest, every time',
    () => {
      syncResourcesToVersion('claude', writeTarget!, undefined, { force: true, cwd });
    },
    { time: 3000, iterations: 5 },
  );

  bench(
    'guard-hit sync (no force, no selection) -- the versions.ts:2878 early return when nothing drifted',
    () => {
      syncResourcesToVersion('claude', writeTarget!, undefined, { cwd });
    },
    { time: 2000 },
  );
});

describe.skipIf(!writeTarget || Object.keys(hookManifest).length === 0)(
  'stage 5 -- hook lifecycle registration (refresh.ts:275/289), run once per installed version',
  () => {
    bench('parseHookManifest (hooks.ts:1369) -- refresh.ts:275, once per refresh', () => {
      parseHookManifest({ warn: false });
    });

    bench('registerHooksToSettings (hooks.ts:1611) -- refresh.ts:289, once PER VERSION', () => {
      registerHooksToSettings('claude', getVersionHomePath('claude', writeTarget!), hookManifest);
    });
  },
);

describe.skipIf(guardHitVersions.length < 2)(
  `stage 6 -- per-version fan-out (refresh.ts:207-209): ${guardHitVersions.length} of ${installedClaude.length} installed claude versions are guard hits`,
  () => {
    bench('syncResourcesToVersion across every guard-hit claude version', () => {
      for (const v of guardHitVersions) {
        syncResourcesToVersion('claude', v, undefined, { cwd });
      }
    }, { time: 3000 });
  },
);

if (writeTargetManifestPath) {
  process.on('exit', () => {
    try {
      if (writeTargetManifestBefore === null) fs.rmSync(writeTargetManifestPath, { force: true });
      else fs.writeFileSync(writeTargetManifestPath, writeTargetManifestBefore);
    } catch (err) {
      console.error(`sync-umbrella.bench: FAILED to restore ${writeTargetManifestPath}: ${(err as Error).message}`);
    }
  });
}
