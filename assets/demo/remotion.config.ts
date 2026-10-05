/** Note: when using the Node.JS APIs, this config file does not apply; pass options directly to the
 * APIs. All options: https://remotion.dev/docs/config */

import { Config } from "@remotion/cli/config";
import { enableTailwind } from '@remotion/tailwind-v4';

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
Config.overrideWebpackConfig(enableTailwind);
