import * as vscode from "vscode";

let channel: vscode.LogOutputChannel | undefined;

export function initLogging(): vscode.Disposable {
  channel = vscode.window.createOutputChannel("NightRider AI", { log: true });
  return channel;
}

export function logInfo(message: string, ...args: unknown[]): void {
  channel?.info(message, ...args);
}

export function logWarn(message: string, ...args: unknown[]): void {
  channel?.warn(message, ...args);
}

export function logError(message: string, ...args: unknown[]): void {
  channel?.error(message, ...args);
}
