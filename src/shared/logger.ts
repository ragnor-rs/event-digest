export class Logger {
  constructor(private isVerbose: boolean) {}

  log(message: string): void {
    console.log(message);
  }

  verbose(message: string): void {
    if (this.isVerbose) {
      console.log(message);
    }
  }

  error(message: string, error?: unknown): void {
    if (error instanceof Error) {
      console.error(message, error.message);
      if (error.stack) {
        console.error(error.stack);
      }
    } else if (error !== undefined) {
      console.error(message, String(error));
    } else {
      console.error(message);
    }
  }
}
