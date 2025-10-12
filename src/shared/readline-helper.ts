import * as readline from 'readline';

interface MutableReadline extends readline.Interface {
  stdoutMuted?: boolean;
  output?: NodeJS.WriteStream;
  _writeToOutput?: (stringToWrite: string) => void;
}

export async function promptForPassword(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  }) as MutableReadline;

  return new Promise((resolve) => {
    rl.stdoutMuted = true;
    rl.question('Password? ', (answer: string) => {
      rl.stdoutMuted = false;
      if (rl.output) rl.output.write('\n');
      rl.close();
      resolve(answer);
    });
    rl._writeToOutput = (stringToWrite: string) => {
      if (rl.stdoutMuted && stringToWrite !== 'Password? ') {
        if (rl.output) rl.output.write('*');
      } else {
        if (rl.output) rl.output.write(stringToWrite);
      }
    };
  });
}

export async function promptForCode(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  }) as MutableReadline;

  return new Promise((resolve) => {
    rl.stdoutMuted = true;
    rl.question('Verification Code? ', (answer: string) => {
      rl.stdoutMuted = false;
      if (rl.output) rl.output.write('\n');
      rl.close();
      resolve(answer);
    });
    rl._writeToOutput = (stringToWrite: string) => {
      if (rl.stdoutMuted && stringToWrite !== 'Verification Code? ') {
        if (rl.output) rl.output.write('*');
      } else {
        if (rl.output) rl.output.write(stringToWrite);
      }
    };
  });
}
