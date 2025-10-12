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

  error(message: string, error?: any): void {
    console.error(message, error || '');
  }
}
