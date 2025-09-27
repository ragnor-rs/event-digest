import { Config } from './types';

export function parseArgs(): Config {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log(`Usage: npm run dev -- \\
  --groups "group1,group2" \\
  --channels "channel1,channel2" \\
  --interests "интерес1,интерес2" \\
  --timeslots "6 14:00,0 14:00" \\
  [--last-timestamp "2011-08-12T20:17:46.384Z"] \\
  [--max-messages 100]`);
    process.exit(1);
  }

  const config: Partial<Config> = {};
  
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    
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
        break;
    }
  }

  config.maxInputMessages = config.maxInputMessages || 100;
  config.eventMessageCues = {
    ru: ["сентября", "сегодня", "часов", "завтра", "послезавтра", "января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "октября", "ноября", "декабря"],
    en: ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december", "tonight", "tomorrow", "today"]
  };

  if (!config.groupsToParse || !config.channelsToParse || !config.userInterests || !config.weeklyTimeslots) {
    console.error('Missing required arguments');
    process.exit(1);
  }

  return config as Config;
}