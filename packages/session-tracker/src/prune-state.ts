#!/usr/bin/env node

import { cleanupOrphanedStateFiles } from './state-file.js';

await cleanupOrphanedStateFiles();
