import { render } from "ink";
import type { AppServices } from "../app/services.js";
import { Dashboard } from "./dashboard.js";
import { holdMouse, mouseHeld, MOUSE_OFF, MOUSE_ON } from "./mouse.js";

/**
 * Runs the terminal interface until the user leaves it, full screen: a
 * dashboard of sessions in tabs (F2 its home page). The
 * mouse wheel scrolls the conversation (select text with Shift and the
 * mouse, or F6 to release the mouse and F6 again to take it back);
 * `GRAFENO_AGENT_MOUSE=off` leaves the mouse to the terminal.
 */
export async function runTui(services: AppServices): Promise<void> {
  const mouse = process.stdout.isTTY && process.env.GRAFENO_AGENT_MOUSE !== "off";
  const instance = render(<Dashboard services={services} />, {
    exitOnCtrlC: false,
    alternateScreen: true,
  });
  const off = () => {
    if (mouse && mouseHeld()) process.stdout.write(MOUSE_OFF);
  };
  if (mouse) {
    process.stdout.write(MOUSE_ON);
    holdMouse((data) => process.stdout.write(data));
    process.once("exit", off);
  }
  try {
    await instance.waitUntilExit();
  } finally {
    off();
  }
}
