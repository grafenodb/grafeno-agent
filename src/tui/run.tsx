import { render } from "ink";
import type { AppServices } from "../app/services.js";
import { App } from "./app.js";

/** Runs the terminal interface until the user leaves it. */
export async function runTui(services: AppServices): Promise<void> {
  const instance = render(<App services={services} />, {
    exitOnCtrlC: false,
    alternateScreen: true,
  });
  await instance.waitUntilExit();
}
