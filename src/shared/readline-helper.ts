import * as readline from 'readline';

/**
 * Extended interface for readline that includes private/mutable properties
 * needed for password masking functionality.
 *
 * Note: This uses implicit typing for some properties as they are internal
 * to the readline module and not officially exported in TypeScript definitions.
 * These properties are:
 * - stdoutMuted: Custom flag to control output masking
 * - _writeToOutput: Private method that can be overridden to mask input
 *
 * This is a pragmatic approach to enable password masking without requiring
 * external dependencies. The properties exist at runtime and are safe to use,
 * but TypeScript doesn't know about them in the official type definitions.
 */
interface MutableReadline extends readline.Interface {
  stdoutMuted?: boolean;
  output?: NodeJS.WriteStream;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _writeToOutput?: (stringToWrite: string) => void;
}

/**
 * Prompts for a password with input masking (displays asterisks).
 * Uses readline's internal _writeToOutput method to mask characters.
 *
 * @returns Promise that resolves to the entered password string
 */
export async function promptForPassword(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  }) as MutableReadline;

  return new Promise((resolve) => {
    rl.stdoutMuted = true;
    rl.question('Password? ', (answer: string) => {
      rl.stdoutMuted = false;
      if (rl.output) rl.output.write('\n');
      rl.close();
      resolve(answer);
    });
    // Override the private _writeToOutput method to mask password input
    rl._writeToOutput = (stringToWrite: string) => {
      if (rl.stdoutMuted && stringToWrite !== 'Password? ') {
        if (rl.output) rl.output.write('*');
      } else {
        if (rl.output) rl.output.write(stringToWrite);
      }
    };
  });
}

/**
 * Prompts for a verification code with input masking (displays asterisks).
 * Uses readline's internal _writeToOutput method to mask characters.
 *
 * @returns Promise that resolves to the entered verification code string
 */
export async function promptForCode(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  }) as MutableReadline;

  return new Promise((resolve) => {
    rl.stdoutMuted = true;
    rl.question('Verification Code? ', (answer: string) => {
      rl.stdoutMuted = false;
      if (rl.output) rl.output.write('\n');
      rl.close();
      resolve(answer);
    });
    // Override the private _writeToOutput method to mask code input
    rl._writeToOutput = (stringToWrite: string) => {
      if (rl.stdoutMuted && stringToWrite !== 'Verification Code? ') {
        if (rl.output) rl.output.write('*');
      } else {
        if (rl.output) rl.output.write(stringToWrite);
      }
    };
  });
}
