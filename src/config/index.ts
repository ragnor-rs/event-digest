import path from 'path';

import { parseCommandLineArgs } from './args-parser';
import { Config } from './types';
import { validateAndCompleteConfig } from './validator';
import { loadYamlConfig } from './yaml-loader';

export function parseArgs(): Config {
  const args = process.argv.slice(2);

  // Start with empty config
  let config: Partial<Config> = {};

  // Check for YAML config file first
  const configArg = args.find((arg) => arg.startsWith('--config='));
  if (configArg) {
    const configPath = configArg.split('=')[1];
    const yamlConfig = loadYamlConfig(configPath);
    if (yamlConfig) {
      config = yamlConfig;
    }
  } else {
    // Check for default config.yaml
    const defaultConfigPaths = [path.join(process.cwd(), 'config.yaml'), path.join(process.cwd(), 'config.yml')];

    for (const configPath of defaultConfigPaths) {
      const yamlConfig = loadYamlConfig(configPath);
      if (yamlConfig) {
        config = yamlConfig;
        break;
      }
    }
  }

  // Parse command line arguments and merge with YAML config (CLI overrides YAML)
  const cliConfig = parseCommandLineArgs(args);
  config = { ...config, ...cliConfig };

  // If no config source provided, show usage
  if (Object.keys(config).length === 0 && args.length === 0) {
    throw new Error(`No configuration provided.

Usage:
  Option 1 - YAML config file:
    npm run dev -- --config=config.yaml

  Option 2 - Command line arguments:
    npm run dev -- \\
      --groups "group1,group2" \\
      --channels "channel1,channel2" \\
      --interests "Interest1,Interest2" \\
      --timeslots "6 14:00,0 14:00" \\
      [--max-group-messages 200] \\
      [--max-channel-messages 100] \\
      [--skip-online-events true] \\
      [--write-debug-files false] \\
      [--verbose-logging false] \\
      [--gpt-batch-size-event-detection 16] \\
      [--gpt-batch-size-event-classification 16] \\
      [--gpt-batch-size-schedule-extraction 16] \\
      [--gpt-batch-size-event-description 5] \\
      [--last-timestamp "2011-08-12T20:17:46.384Z"] \\
      [--max-messages 100]

  Option 3 - Default config file (config.yaml or config.yml in project root)

  Option 4 - Mix YAML and CLI (CLI arguments override YAML values):
    npm run dev -- --verbose-logging true`);
  }

  return validateAndCompleteConfig(config);
}

export * from './types';
