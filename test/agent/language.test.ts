import { describe, expect, it } from "vitest";
import { detectLanguage, withLanguage } from "../../src/agent/language.js";

describe("the user's language", () => {
  it("is told from the message's common words", () => {
    expect(detectLanguage("¿Puedes crear una carpeta para los tests?")).toBe("Spanish");
    expect(detectLanguage("Ahora quiero que agregues un archivo con la función")).toBe("Spanish");
    expect(detectLanguage("Can you create a folder for the tests?")).toBe("English");
    expect(detectLanguage("Please fix the bug in this file")).toBe("English");
    expect(detectLanguage("Você pode criar uma pasta para os testes?")).toBe("Portuguese");
    expect(detectLanguage("Peux-tu créer un dossier pour les tests ?")).toBe("French");
    expect(detectLanguage("Kannst du bitte einen Ordner für die Tests erstellen?")).toBe("German");
  });

  it("says nothing when the message is too short or only code", () => {
    expect(detectLanguage("ok")).toBeUndefined();
    expect(detectLanguage("sí")).toBeUndefined();
    expect(detectLanguage("`npm run build` src/app.ts")).toBeUndefined();
  });

  it("is said to the model just before the user's words, after the memory", () => {
    const message = "Crea una carpeta para los tests";
    const prepared = `<memory>\nThe project uses vitest.\n</memory>\n\n${message}`;
    const sent = withLanguage(prepared, message, "Spanish");
    expect(sent).toMatch(
      /<\/memory>\n\n\[The user writes in Spanish: answer in Spanish.*\]\n\nCrea una carpeta/,
    );
    expect(withLanguage(message, message, undefined)).toBe(message);
  });
});
