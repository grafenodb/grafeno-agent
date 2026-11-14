import { render } from "ink";
import type { AppServices } from "../app/services.js";
import { App } from "./app.js";
import { MOUSE_OFF, MOUSE_ON } from "./mouse.js";

/**
 * Runs the terminal interface until the user leaves it, full screen. The
 * mouse wheel scrolls the conversation (select text with Shift and the
 * mouse); `GRAFENO_AGENT_MOUSE=off` leaves the mouse to the terminal.
 */
export async function runTui(services: AppServices): Promise<void> {
  const mouse = process.stdout.isTTY && process.env.GRAFENO_AGENT_MOUSE !== "off";
  const instance = render(<App services={services} />, {
    exitOnCtrlC: false,
    alternateScreen: true,
  });
  const off = () => {
    if (mouse) process.stdout.write(MOUSE_OFF);
  };
  if (mouse) {
    process.stdout.write(MOUSE_ON);
    process.once("exit", off);
  }
  try {
    await instance.waitUntilExit();
  } finally {
    off();
  }
}
