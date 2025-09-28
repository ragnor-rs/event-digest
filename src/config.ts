import { Config } from './types';
import * as yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';

function loadYamlConfig(filePath: string): Partial<Config> | null {
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

export function parseArgs(): Config {
  const args = process.argv.slice(2);
  console.log(`DEBUG: Raw arguments:`, args);
  
  // Check for YAML config file first
  const configArg = args.find(arg => arg.startsWith('--config='));
  if (configArg) {
    const configPath = configArg.split('=')[1];
    const yamlConfig = loadYamlConfig(configPath);
    if (yamlConfig) {
      return validateAndCompleteConfig(yamlConfig);
    }
  }
  
  // Check for default config.yaml
  const defaultConfigPaths = [
    path.join(process.cwd(), 'config.yaml'),
    path.join(process.cwd(), 'config.yml')
  ];
  
  for (const configPath of defaultConfigPaths) {
    const yamlConfig = loadYamlConfig(configPath);
    if (yamlConfig) {
      return validateAndCompleteConfig(yamlConfig);
    }
  }
  
  // Fall back to command line arguments
  if (args.length === 0) {
    console.log(`Usage: 
  Option 1 - YAML config file:
    npm run dev -- --config=config.yaml
    
  Option 2 - Command line arguments:
    npm run dev -- \\
      --groups "group1,group2" \\
      --channels "channel1,channel2" \\
      --interests "интерес1,интерес2" \\
      --timeslots "6 14:00,0 14:00" \\
      [--last-timestamp "2011-08-12T20:17:46.384Z"] \\
      [--max-messages 100]
      
  Option 3 - Default config file (config.yaml or config.yml in project root)`);
    process.exit(1);
  }

  const config: Partial<Config> = {};
  
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    console.log(`DEBUG: Processing ${key} = ${value}`);
    
    switch (key) {
      case '--groups':
        config.groupsToParse = value.split(',').map(s => s.trim());
        break;
      case '--channels':
        config.channelsToParse = value.split(',').map(s => s.trim());
        break;
      case '--interests':
        config.userInterests = value.split(',').map(s => s.trim());
        break;
      case '--timeslots':
        config.weeklyTimeslots = value.split(',').map(s => s.trim());
        break;
      case '--last-timestamp':
        config.lastGenerationTimestamp = value;
        break;
      case '--max-messages':
        config.maxInputMessages = parseInt(value);
        console.log(`DEBUG: Parsed --max-messages: ${value} -> ${config.maxInputMessages}`);
        break;
      case '--max-group-messages':
        config.maxGroupMessages = parseInt(value);
        console.log(`DEBUG: Parsed --max-group-messages: ${value} -> ${config.maxGroupMessages}`);
        break;
      case '--max-channel-messages':
        config.maxChannelMessages = parseInt(value);
        console.log(`DEBUG: Parsed --max-channel-messages: ${value} -> ${config.maxChannelMessages}`);
        break;
    }
  }

  return validateAndCompleteConfig(config);
}

function validateAndCompleteConfig(config: Partial<Config>): Config {
  // Set defaults for separate limits
  if (config.maxGroupMessages === undefined && config.maxChannelMessages === undefined) {
    // If neither is specified, use legacy maxInputMessages or defaults
    const legacyLimit = config.maxInputMessages || 100;
    config.maxGroupMessages = Math.floor(legacyLimit * 1.5); // Groups need more messages due to noise
    config.maxChannelMessages = legacyLimit;
  } else {
    // Set individual defaults if only one is specified
    if (config.maxGroupMessages === undefined) {
      config.maxGroupMessages = config.maxChannelMessages ? Math.floor(config.maxChannelMessages * 1.5) : 150;
    }
    if (config.maxChannelMessages === undefined) {
      config.maxChannelMessages = config.maxGroupMessages ? Math.floor(config.maxGroupMessages / 1.5) : 100;
    }
  }
  
  console.log(`DEBUG: Setting maxGroupMessages = ${config.maxGroupMessages}, maxChannelMessages = ${config.maxChannelMessages}`);
  
  if (!config.eventMessageCues) {
    config.eventMessageCues = {
      ru: ["сентября", "сегодня", "часов", "завтра", "послезавтра", "января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "октября", "ноября", "декабря"],
      en: ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december", "tonight", "tomorrow", "today"]
    };
  }

  // Validate required fields
  if (!config.groupsToParse || !config.channelsToParse || !config.userInterests || !config.weeklyTimeslots) {
    console.error('Missing required configuration fields:');
    console.error('Required: groupsToParse, channelsToParse, userInterests, weeklyTimeslots');
    process.exit(1);
  }

  return config as Config;
}