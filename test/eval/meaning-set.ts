/**
 * A set of memories and questions to measure what meaning (embeddings)
 * adds to recall over words and the graph alone. The memories are what a
 * programming assistant keeps about a project, in Spanish and English, as
 * the user writes both. Each question has one memory that answers it.
 *
 * - `words`: the question shares the memory's key words;
 * - `paraphrase`: same language, said with other words;
 * - `crosslingual`: asked in the other language.
 */
export const MEMORIES = [
  "The project installs its dependencies with pnpm, not npm.",
  "Los tests de integración necesitan Docker corriendo en local.",
  "Errors returned by the API follow RFC 9457 problem details.",
  "La rotación de guardia cambia cada lunes por la mañana.",
  "Feature flags are managed in LaunchDarkly and never hard-coded.",
  "Las migraciones de la base de datos se ejecutan con Flyway al desplegar.",
  "Container images are published to the GitHub Container Registry.",
  "El usuario prefiere que los mensajes de commit estén en inglés.",
  "Pull requests should stay under four hundred changed lines.",
  "El servicio expone su API bajo el prefijo /v2.",
  "Secrets are injected at runtime from HashiCorp Vault.",
  "La caché usa Redis con una caducidad de diez minutos.",
  "The frontend is built with React and Vite.",
  "Los logs se envían a Grafana Loki y se guardan treinta días.",
  "Releases are tagged with semantic versions and a changelog entry.",
  "El usuario no quiere dependencias nuevas sin hablarlo antes.",
  "Background jobs run on a BullMQ queue backed by Redis.",
  "Los correos transaccionales se mandan con Postmark.",
  "The mobile app talks to the backend only through the GraphQL gateway.",
  "La documentación interna vive en el wiki de Notion del equipo.",
  "Load tests are written with k6 and run before each major release.",
  "El linter es ESLint con la configuración estricta de typescript-eslint.",
  "Customer data must stay in servers located in the European Union.",
  "Las fechas se guardan siempre en UTC y se muestran en la zona del usuario.",
  "The team holds a retrospective every second Friday.",
  "Para los pagos se usa Stripe en modo de prueba fuera de producción.",
  "Database backups run nightly and are kept for ninety days.",
  "El código de autenticación lo revisan siempre dos personas.",
  "Search is powered by Meilisearch with Spanish stemming enabled.",
  "La aplicación de escritorio se distribuye con Tauri.",
] as const;

export type QuestionKind = "words" | "paraphrase" | "crosslingual";

export interface Question {
  readonly text: string;
  /** The index in MEMORIES of the memory that answers it. */
  readonly answer: number;
  readonly kind: QuestionKind;
}

export const QUESTIONS: readonly Question[] = [
  // Shares the key words.
  { text: "Does the project use pnpm or npm for dependencies?", answer: 0, kind: "words" },
  { text: "¿Qué necesitan los tests de integración en local?", answer: 1, kind: "words" },
  { text: "Where are container images published?", answer: 6, kind: "words" },
  { text: "¿Bajo qué prefijo expone el servicio su API?", answer: 9, kind: "words" },
  { text: "What builds the frontend, React and Vite?", answer: 12, kind: "words" },
  { text: "¿Adónde se envían los logs?", answer: 13, kind: "words" },
  { text: "What are load tests written with?", answer: 20, kind: "words" },
  { text: "¿Qué linter usa el proyecto?", answer: 21, kind: "words" },
  { text: "How often do database backups run?", answer: 26, kind: "words" },
  { text: "¿Con qué se distribuye la aplicación de escritorio?", answer: 29, kind: "words" },
  // Same language, other words.
  { text: "Which tool should I use to add a library to the repo?", answer: 0, kind: "paraphrase" },
  {
    text: "¿Quién está de turno para incidencias esta semana y cuándo cambia?",
    answer: 3,
    kind: "paraphrase",
  },
  {
    text: "How do we turn a feature on for some users without a deploy?",
    answer: 4,
    kind: "paraphrase",
  },
  {
    text: "¿Cómo se actualiza el esquema de la base de datos en producción?",
    answer: 5,
    kind: "paraphrase",
  },
  { text: "How big may a change be before I split it for review?", answer: 8, kind: "paraphrase" },
  {
    text: "Where do the passwords and API keys come from when the app starts?",
    answer: 10,
    kind: "paraphrase",
  },
  { text: "¿Puedo añadir un paquete de terceros por mi cuenta?", answer: 15, kind: "paraphrase" },
  { text: "Where can customer records legally be hosted?", answer: 22, kind: "paraphrase" },
  { text: "¿En qué huso horario se almacenan los instantes?", answer: 23, kind: "paraphrase" },
  {
    text: "How often does the team look back on how the sprint went?",
    answer: 24,
    kind: "paraphrase",
  },
  // The other language.
  {
    text: "What do integration tests need running on my machine?",
    answer: 1,
    kind: "crosslingual",
  },
  { text: "¿Qué formato tienen los errores que devuelve la API?", answer: 2, kind: "crosslingual" },
  { text: "In which language should commit messages be written?", answer: 7, kind: "crosslingual" },
  { text: "How long are cached values kept?", answer: 11, kind: "crosslingual" },
  { text: "¿Qué cola procesa los trabajos en segundo plano?", answer: 16, kind: "crosslingual" },
  { text: "Which service sends transactional emails?", answer: 17, kind: "crosslingual" },
  { text: "¿Cómo se comunica la app móvil con el backend?", answer: 18, kind: "crosslingual" },
  { text: "Where is the team's internal documentation?", answer: 19, kind: "crosslingual" },
  { text: "Who reviews changes to the authentication code?", answer: 27, kind: "crosslingual" },
  { text: "¿Qué motor de búsqueda usa el producto?", answer: 28, kind: "crosslingual" },
];
