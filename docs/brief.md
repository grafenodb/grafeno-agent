# Brief: autonomous multi-agent orchestration (the user's, verbatim)

Given by the user on 2026-11-14 and re-sent on 2026-11-15. It is kept here
in its own words (Spanish) so any session can read it. Status against it is
tracked in [`ROADMAP.md`](../ROADMAP.md) ("Orchestration") and in
[`docs/orchestration.md`](orchestration.md).

Decisions taken with the user after this brief override it where they
differ. On 2026-11-15 the user chose to go ahead with phase B, with Codex
CLI as a real second provider (§B.5 had said Claude Code alone in the
first delivery).

---

Implementación de orquestación autónoma multiagente en Grafeno Agent

## 1. Contexto del proyecto

Estamos desarrollando Grafeno Agent, un agente de programación en TypeScript que utiliza Claude Code como proveedor de razonamiento y Grafeno como motor independiente de memoria persistente y cognitiva.

Repositorios:

- Grafeno: `https://github.com/grafenodb/grafeno`
- Grafeno Agent: `https://github.com/grafenodb/grafeno-agent`

Grafeno proporciona memoria persistente, relaciones entre entidades, recuperación contextual, checkpoints, Palacio Mental y mecanismos de gestión de conocimiento.

Grafeno Agent ya dispone de un adaptador para Claude Code, herramientas propias, permisos, gestión de sesiones, memoria por proyecto y pruebas.

Objetivo principal: evolucionar Grafeno Agent hacia un orquestador autónomo multiagente y, posteriormente, multimodelo, capaz de planificar, descomponer, asignar, ejecutar, supervisar, verificar e integrar tareas complejas automáticamente.

### Restricción fundamental

Por ahora, utilizar exclusivamente Claude Code mediante el CLI oficial y la suscripción existente del usuario.

No implementar todavía integraciones funcionales con Codex, Gemini, Grok, Ollama ni otros proveedores.

Sin embargo, diseñar las interfaces y los contratos necesarios para incorporarlos posteriormente sin reestructurar el núcleo de orquestación.

No utilizar APIs de pago por tokens, extraer credenciales, reutilizar tokens de autenticación ni intentar eludir las cuotas o condiciones de los proveedores.

El objetivo inmediato es disponer de varios workers Claude Code funcionando en paralelo, con diferentes modelos y niveles de razonamiento, seleccionados automáticamente.

## 2. Principios arquitectónicos

Cumplir los siguientes principios:

1. Separación de responsabilidades: Grafeno continúa siendo un motor de memoria independiente. La orquestación pertenece exclusivamente a Grafeno Agent.
2. Autonomía controlada: los LLM planifican y razonan; un motor determinista valida y ejecuta las decisiones siguiendo políticas explícitas.
3. Arquitectura extensible: ningún componente del orquestador debe depender directamente de Claude Code, excepto su adaptador.
4. Memoria compartida: los subagentes pueden recuperar conocimiento relevante de Grafeno, respetando permisos y procedencia.
5. Aislamiento de ejecución: los workers no deben modificar simultáneamente el mismo espacio de trabajo sin coordinación.
6. Optimización de contexto: cada worker recibe únicamente el conocimiento necesario.
7. Seguridad: ningún modelo puede saltarse las políticas de permisos, incluso cuando proponga una acción explícitamente.
8. Observabilidad: toda tarea, ejecución, fallo, decisión y asignación debe poder inspeccionarse.
9. Recuperación: el sistema debe poder continuar después de interrupciones sin duplicar operaciones peligrosas.
10. Compatibilidad: conservar las funcionalidades actuales de Grafeno Agent y evitar regresiones.

No realizar una reescritura completa del proyecto.

Antes de implementar, inspeccionar el código existente y reutilizar sus interfaces, servicios, herramientas y convenciones.

## FASE A — Orquestación multiagente con Claude Code

Esta es la fase prioritaria. Implementarla, probarla y estabilizarla antes de avanzar a la Fase B.

### A.1. Planner

Implementar un planificador capaz de recibir una solicitud compleja y transformarla en un plan estructurado.

Por ejemplo: "Desarrolla un sistema de gestión de pacientes con backend NestJS, frontend React, autenticación, pruebas y documentación."

El Planner debe identificar: objetivo general; tareas y subtareas; dependencias; complejidad estimada; capacidades requeridas; archivos y componentes afectados; criterios de aceptación; riesgos; posibilidades de paralelización; modelo y esfuerzo recomendados.

Representar el plan como un DAG (grafo dirigido acíclico).

Validar programáticamente el esquema del plan y rechazar dependencias circulares, referencias inexistentes y tareas sin criterios de finalización.

El Planner puede utilizar Claude Code, pero el resultado debe validarse mediante reglas deterministas.

### A.2. Scheduler determinista

Implementar un motor de planificación y ejecución que: identifique tareas cuyas dependencias estén satisfechas; ejecute tareas independientes en paralelo; limite el número de workers concurrentes; respete los límites de recursos; mantenga estados persistentes de las tareas; detecte bloqueos y dependencias fallidas; aplique timeouts; gestione cancelaciones; permita pausar y reanudar ejecuciones; reintente operaciones recuperables con límites configurables; evite ejecutar dos veces una operación con efectos irreversibles.

Estados mínimos: `pending`, `ready`, `running`, `blocked`, `review`, `completed`, `failed`, `cancelled`.

Los cambios de estado deben seguir transiciones válidas y comprobables.

El Scheduler no debe depender de que un LLM esté continuamente activo.

### A.3. Worker Manager

Crear un administrador de subagentes que permita ejecutar múltiples instancias independientes de Claude Code.

Cada worker tendrá: identificador único; tarea asignada; modelo seleccionado; nivel de razonamiento; sesión independiente; workspace aislado; presupuesto de recursos; estado de ejecución; referencias a memoria de Grafeno; herramientas y permisos específicos; señales de cancelación y timeout.

Permitir distintos perfiles de worker, por ejemplo:

- Worker de arquitectura: Claude con modelo de razonamiento avanzado; esfuerzo alto; responsable de contratos, decisiones y diseño.
- Worker de backend: Claude con modelo avanzado; esfuerzo alto; implementación de lógica compleja.
- Worker de frontend: Claude con modelo adecuado para desarrollo; esfuerzo configurable.
- Worker de pruebas: Claude con esfuerzo bajo o medio; creación y ejecución de pruebas.
- Worker de documentación: Claude con un modelo o esfuerzo económico; actualización de documentación técnica.

No fijar nombres de modelos específicos en el núcleo del sistema. Descubrir o validar los modelos y niveles de esfuerzo que el CLI instalado realmente admita.

Si un modelo no está disponible, seleccionar otro compatible según una política explícita.

### A.4. Ejecución paralela y Git worktrees

Implementar aislamiento mediante Git worktrees cuando sea aplicable.

Cada worker de desarrollo debe trabajar en su propio worktree y rama temporal.

El sistema debe: crear worktrees; asociarlos a tareas; registrar cambios; detectar conflictos; ejecutar validaciones; integrar cambios de manera controlada; limpiar recursos temporales únicamente cuando sea seguro.

No permitir que dos workers escriban simultáneamente en el mismo archivo de un workspace compartido sin un mecanismo de coordinación.

No sobrescribir cambios existentes del usuario.

La integración debe respetar las políticas de autorización.

### A.5. Memoria compartida con Grafeno

Utilizar Grafeno como motor de conocimiento de todos los subagentes.

Cada worker debe poder: recuperar decisiones arquitectónicas; consultar contratos y restricciones; recuperar conocimientos relevantes; registrar decisiones nuevas; relacionar información; crear checkpoints; identificar memorias obsoletas; reconocer qué agente produjo determinada información.

Aprovechar el Palacio Mental y las capacidades existentes.

Mantener separados:

- Memoria cognitiva: hechos, decisiones, relaciones, aprendizajes y contexto semántico en Grafeno.
- Estado operativo: tareas, workers, dependencias, bloqueos, reintentos y ejecución en un almacén transaccional apropiado.

No utilizar el Palacio Mental como sustituto de una cola de tareas o un scheduler.

### A.6. Gestión del contexto acumulado

Implementar un `Context Lifecycle Manager`.

Responsabilidades: monitorear el consumo de contexto por worker; detectar crecimiento excesivo; recuperar contexto relevante bajo demanda; generar checkpoints antes de renovar sesiones; conservar decisiones y resultados importantes; crear sesiones nuevas con contexto reducido; restaurar automáticamente el estado necesario; evitar reenviar conversaciones completas; mantener referencias a archivos y artefactos originales.

Definir umbrales configurables de advertencia y renovación.

No interrumpir operaciones críticas a mitad de ejecución.

No asumir que un resumen conserva todo el estado interno de razonamiento del modelo.

### A.7. Optimización de tokens

Implementar un `Context Budget Manager` que: asigne presupuestos de contexto por tarea; limite memorias recuperadas; utilice recuperación progresiva; evite información duplicada; reutilice resultados verificables; mantenga referencias en lugar de grandes bloques de texto; registre tokens de entrada, salida y caché cuando el proveedor los reporte; distinga tokens estimados de tokens reales; detecte tareas que pueden resolverse con herramientas deterministas sin consultar un LLM.

No sacrificar información crítica para ahorrar tokens.

### A.8. Verificación e integración

Implementar un sistema de verificación automática.

Cada tarea debe tener criterios de aceptación comprobables.

Cuando corresponda, ejecutar: typecheck; lint; pruebas unitarias; pruebas de integración; build; verificaciones de seguridad; comprobación de contratos API.

Si una tarea falla, devolver el diagnóstico al worker responsable.

Limitar los ciclos de corrección para evitar bucles infinitos.

No considerar una tarea completada solamente porque el LLM afirme que terminó.

### A.9. Seguridad y autonomía

Implementar políticas configurables: `supervised`, `controlled`, `extended`.

El modo predeterminado será `controlled`.

Permitir automáticamente operaciones previamente autorizadas dentro del workspace aislado.

Solicitar autorización para operaciones sensibles, como: despliegues; publicación remota de cambios; modificaciones de infraestructura; eliminación de información importante; acceso a secretos; operaciones fuera del proyecto; acciones irreversibles.

Mantener prohibiciones absolutas cuando corresponda.

Las políticas deben ser evaluadas por código, no por prompts.

La ejecución de comandos no confiables debe contar con aislamiento real; las validaciones por cadenas de texto no constituyen un sandbox.

### A.10. Criterios de aceptación

La Fase A estará terminada cuando:

1. El usuario pueda solicitar una tarea compleja mediante un único mensaje.
2. Claude genere un plan estructurado válido.
3. El Scheduler identifique dependencias y paralelismo.
4. Se ejecuten al menos tres workers Claude Code independientes.
5. Los workers puedan utilizar diferentes modelos o niveles de esfuerzo admitidos.
6. Cada worker tenga aislamiento de archivos.
7. Grafeno comparta el conocimiento relevante entre workers.
8. Se registren checkpoints y estados operativos.
9. Se detecten fallos y se recuperen ejecuciones seguras.
10. Se ejecuten pruebas de integración.
11. Los cambios puedan integrarse sin sobrescribir trabajo del usuario.
12. Se respeten permisos y cuotas.
13. Se pueda continuar una tarea interrumpida.
14. Existan pruebas automatizadas de los componentes principales.

No avanzar a la Fase B hasta demostrar estos criterios mediante pruebas.

## FASE B — Arquitectura multimodelo

Preparar su diseño desde la Fase A, pero implementar adaptadores adicionales únicamente después de estabilizar Claude.

### B.1. Abstracción de proveedores

Definir interfaces independientes del proveedor para: descubrimiento de capacidades; detección de autenticación; listado o validación de modelos; niveles de razonamiento; inicio y finalización de sesiones; streaming; ejecución de herramientas; cancelación; recuperación de errores; consumo y cuotas; disponibilidad; context window; compatibilidad con ejecución no interactiva.

No asumir que todos los proveedores ofrecen las mismas funciones.

### B.2. Adaptadores futuros

Preparar la arquitectura para: Claude Code; Codex CLI; Gemini CLI; Grok, si existe una vía oficial compatible; otros proveedores autorizados.

Cada adaptador debe utilizar exclusivamente mecanismos oficiales y permitidos.

No implementar accesos mediante credenciales extraídas de aplicaciones ni mecanismos de evasión de límites.

### B.3. Capability Registry

Diseñar un registro de capacidades por proveedor y modelo.

Debe permitir responder: ¿Puede programar? ¿Puede utilizar herramientas? ¿Admite ejecución en segundo plano? ¿Admite streaming? ¿Qué esfuerzos de razonamiento permite? ¿Puede reanudar sesiones? ¿Qué información de consumo proporciona? ¿Está autenticado? ¿Está disponible?

Las capacidades deben verificarse cuando sea posible, no asumirse.

### B.4. Fallbacks

Diseñar fallbacks seguros.

Si un modelo no está disponible, el sistema debe: 1. identificar la causa; 2. buscar alternativas compatibles; 3. verificar permisos y límites; 4. conservar el checkpoint; 5. reasignar la tarea cuando sea seguro; 6. evitar repetir efectos secundarios.

No cambiar de proveedor si ello incumple una política del usuario.

### B.5. Condición de implementación

Durante la primera entrega, mantener Claude Code como único proveedor operativo.

La Fase B debe quedar documentada como ampliación posterior, sin añadir complejidad innecesaria a la Fase A.

## FASE C — Enrutamiento inteligente

Diseñar un `Intelligent Model Router` que aprenda de métricas reales de ejecución.

### C.1. Métricas

Registrar por tarea: tipo de trabajo; complejidad estimada; modelo utilizado; nivel de esfuerzo; duración; tokens consumidos; utilización de cuota cuando esté disponible; número de reintentos; número de correcciones; resultado de pruebas; resultado de revisión; calidad observada; motivo de fallo.

Evitar almacenar secretos o contenido sensible en la telemetría.

### C.2. Selección automática

El Router debe considerar: capacidades; complejidad; disponibilidad; historial de éxito; consumo; tiempo estimado; riesgo; preferencias del usuario.

Inicialmente utilizar reglas explícitas y estadísticas sencillas.

No introducir aprendizaje automático complejo sin demostrar una mejora frente a una política base.

### C.3. Aprendizaje progresivo

Permitir que el sistema aprenda qué modelos funcionan mejor para: arquitectura; backend; frontend; pruebas; documentación; refactorización; depuración; revisión de seguridad.

Evitar concluir que un modelo es mejor a partir de muestras pequeñas o tareas no comparables.

### C.4. Restricción actual

En esta etapa inicial, las métricas y la selección inteligente deben funcionar solo con Claude Code, comparando los modelos y esfuerzos realmente disponibles.

La optimización entre proveedores llegará después de implementar la Fase B.

## FASE D — Orquestación autónoma completa

Construir progresivamente un sistema capaz de ejecutar trabajos prolongados con mínima intervención.

### D.1. Replanificación

Cuando una tarea falle o cambien sus requisitos: analizar el problema; identificar tareas afectadas; proponer un plan actualizado; validar dependencias; conservar resultados válidos; reprogramar únicamente el trabajo necesario.

No reconstruir todo el proyecto ante un fallo localizado.

### D.2. Ejecución en segundo plano

Permitir trabajos persistentes que continúen sin mantener abierta la interfaz de terminal.

El sistema debe poder: consultar el progreso; pausar; reanudar; cancelar; recuperarse de reinicios; mostrar errores; notificar resultados.

La ejecución debe estar controlada por un servicio o proceso supervisor adecuado.

### D.3. Recuperación de fallos

Implementar recuperación ante: caída de un worker; timeout; interrupción del proceso; fallo del proveedor; agotamiento de cuota; conflictos Git; pruebas fallidas; pérdida de conexión con Grafeno.

Aplicar idempotencia y límites de reintentos.

### D.4. Revisión cruzada

Permitir que un worker revise el trabajo de otro. Ejemplo: Worker A implementa backend; Worker B revisa contratos y seguridad; Worker C ejecuta pruebas; el integrador acepta el resultado únicamente cuando se cumplen los criterios.

No considerar que dos respuestas de LLM equivalen a una verificación objetiva.

Priorizar pruebas ejecutables y evidencias comprobables.

### D.5. Integración autónoma

Permitir integrar cambios automáticamente dentro de los límites autorizados.

La integración debe: comprobar conflictos; ejecutar pruebas; verificar criterios; registrar el origen; preservar cambios del usuario; mantener una estrategia de recuperación.

Las acciones externas sensibles requieren autorización.

### D.6. Control de recursos

Establecer límites globales y por worker: concurrencia; tiempo; reintentos; consumo de tokens reportados; presupuesto de contexto; uso de CPU y memoria cuando sea medible; utilización de cuotas; tamaño de resultados de herramientas.

No intentar eludir los límites de los proveedores.

## 3. Estructura del proyecto

Inspeccionar primero la estructura real de `grafeno-agent`.

Proponer módulos que se integren con el código existente, conceptualmente similares a:

```
src/
  orchestrator/
    planner/
    scheduler/
    task-graph/
    workers/
    routing/
    integration/
    verification/
    recovery/
    policies/
    telemetry/
    context/
```

Esta estructura es orientativa. No crear directorios vacíos ni introducir abstracciones innecesarias. Reutilizar el modelo de agentes, las herramientas, los adaptadores, los permisos y las sesiones actuales cuando sea posible.

## 4. Estrategia de implementación

Trabajar de forma incremental. Para cada etapa:

1. Inspeccionar la implementación actual.
2. Identificar componentes reutilizables.
3. Documentar decisiones técnicas relevantes.
4. Definir contratos e interfaces.
5. Implementar el cambio mínimo funcional.
6. Crear pruebas unitarias.
7. Crear pruebas de integración.
8. Ejecutar las verificaciones existentes.
9. Corregir regresiones.
10. Actualizar documentación y checkpoints.

No declarar una etapa terminada sin evidencia verificable.

No modificar el repositorio de Grafeno salvo que se identifique una necesidad genuina de funcionalidad general del motor; en ese caso, documentar la propuesta antes de realizar cambios.

## 5. Pruebas obligatorias

Incluir escenarios que verifiquen: tres workers Claude ejecutándose simultáneamente; modelos y esfuerzos diferentes; dependencias del DAG; prevención de ciclos; aislamiento de worktrees; conflictos entre cambios; cancelación; timeouts; reintentos; recuperación tras reinicio; compartición de memoria; atribución de recuerdos por agente; presupuestos de contexto; renovación de sesiones; protección de secretos; rechazo de acciones prohibidas; agotamiento de cuota; fallos de integración; continuidad de funcionalidades existentes.

Utilizar modelos simulados para la mayoría de las pruebas. Ejecutar pruebas reales con Claude Code únicamente cuando sean necesarias, identificando previamente el consumo esperado y respetando las cuotas.

## 6. Entregables

1. Análisis de la arquitectura existente.
2. Diseño técnico de la orquestación.
3. Roadmap detallado por fases.
4. Implementación funcional de la Fase A.
5. Pruebas unitarias y de integración.
6. Evaluación de rendimiento y consumo.
7. Documentación de configuración.
8. Ejemplos de ejecución multiagente.
9. Diseño extensible para las fases B, C y D.
10. Registro de limitaciones, riesgos y decisiones pendientes.

## 7. Instrucción final

Comienza inspeccionando el repositorio actual de Grafeno Agent. No asumas que los componentes descritos ya existen ni que todos los CLI ofrecen las mismas capacidades. Identifica qué está implementado, qué puede reutilizarse y qué falta.

Después, diseña e implementa progresivamente la Fase A: orquestación multiagente utilizando exclusivamente Claude Code.

Prioriza primero: 1. Planner. 2. Task DAG. 3. Scheduler determinista. 4. Worker Manager para Claude Code. 5. Ejecución paralela con Git worktrees. 6. Integración con Grafeno. 7. Verificación e integración de resultados. 8. Gestión de contexto y recuperación.

Mantén la arquitectura preparada para múltiples proveedores, pero no implementes todavía Codex, Gemini, Grok ni otros modelos.

No avances automáticamente a las siguientes fases sin completar y verificar los criterios de aceptación de la fase actual.

Cuando encuentres una decisión arquitectónica importante, presenta las alternativas, sus ventajas y riesgos, y recomienda una opción fundamentada.

El objetivo no es crear simplemente varios procesos Claude Code: es construir un orquestador autónomo, seguro, extensible, eficiente en contexto y capaz de coordinar subagentes que comparten conocimiento mediante Grafeno.
