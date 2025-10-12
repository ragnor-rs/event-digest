import { Config } from './types';
import * as yaml from 'js-yaml';
import fs from 'fs';

export function loadYamlConfig(filePath: string): Partial<Config> | null {
  try {
    if (fs.existsSync(filePath)) {
      const yamlContent = fs.readFileSync(filePath, 'utf-8');
      const config = yaml.load(yamlContent) as Partial<Config>;
      console.log(`Loaded configuration from ${filePath}`);
      return config;
    }
  } catch (error) {
    console.error(`Error loading YAML config from ${filePath}:`, error);
  }
  return null;
}
