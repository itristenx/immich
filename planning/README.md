# Product experience and AI roadmap

The direction is an Apple-inspired personal photo library with strong search, clear sharing, and ownership of the originals. The implementation should build on Immich's existing media pipeline and support AI on this computer or another computer.

- [Experience roadmap](experience-roadmap.md): navigation, visual language, core journeys, architecture, release phases, and acceptance criteria.
- [AI model review](ai-model-review.md): current defaults, every registered model family, all six locally installed Ollama models, current alternatives, and the evaluation plan.
- [Complete model inventory](model-inventory.json): all 75 registered application model IDs, their search-vector dimensions where applicable, default status, local Ollama model digests, and candidate model revisions.

The review is dated October 17, 2026. The source baseline is fork commit `08dc510`, based on upstream `53618ff`. The public demo observed during the UX review identified itself as version `v3.3.3`; its appearance is a reference, not proof that every demo behavior exists in this source snapshot.

The roadmap proposes product changes. The previously implemented ML routing, request deadlines, and concurrent query-embedding sharing are already present on the base branch. Native Gemma integration, the proposed visual refresh, new model adapters, and model migrations remain implementation work. No installed model or live library was changed during this review.
