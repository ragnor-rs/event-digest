import fs from 'fs';

import * as yaml from 'js-yaml';

import { Config } from './types';

export function loadYamlConfig(filePath: string): Partial<Config> | undefined {
  try {
    if (fs.existsSync(filePath)) {
      const yamlContent = fs.readFileSync(filePath, 'utf-8');
      const config = yaml.load(yamlContent) as Partial<Config>;
      console.log(`Loaded configuration from ${filePath}`);
      return config;
    }
  } catch (error) {
    console.error(`Error loading YAML config from ${filePath}:`, error);
    throw new Error(
      `Failed to load YAML config from ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return undefined;
}
