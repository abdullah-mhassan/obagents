import chalk from "chalk";

export const logger = {
  success(message: string): void {
    console.error(chalk.green("✓") + " " + message);
  },
  info(message: string): void {
    console.error(chalk.blue("ℹ") + " " + message);
  },
  warning(message: string): void {
    console.error(chalk.yellow("⚠") + " " + message);
  },
  error(message: string): void {
    console.error(chalk.red("✖") + " " + message);
  },
  raw(message: string): void {
    console.log(message);
  },
};