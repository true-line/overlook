# Repo Documentation Pointer Map

This page maps repository markdown documentation to its canonical home, so
nothing is duplicated. All documentation now lives in this repository under
`docs/`; the GitHub wiki is retired and its pages are stubs pointing here, kept
only so existing issue, PR, and comment links continue to resolve.

| Repository path                    | Canonical home                                                                                     |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| `README.md`                        | Canonical in the repository (quickstart + script table)                                            |
| `CONTRIBUTING.md`                  | Pointer stub → [Contributing](./Contributing.md)                                                   |
| `AGENTS.md`                        | Shared agent-context file (repo-canonical); long-form workflow → [Contributing](./Contributing.md) |
| ADRs                               | [Architecture Decision Records](./adr/Architecture-Decision-Records.md) — index + template         |
| User-story / milestone planning    | [User Stories](./stories/User-Stories.md)                                                          |
| Testing strategy                   | [Testing Strategy](./Testing-Strategy.md)                                                          |
| E2E timing / flake synchronization | [E2E & Storybook Timing Audit](./E2E-Timing-Audit.md)                                              |
| Visual accessibility acceptance    | [Visual Accessibility Acceptance](./acceptance/Acceptance-Test-Visual-Accessibility.md)            |

## Rules

- New process/SOP/planning docs go **in `docs/`** and get a row here only if a
  repo stub exists or is needed for discoverability.
- Update the `docs/` page behind a stub, never the stub itself.
- When adding a repo pointer stub, keep it compact: title, one-line description,
  link, and "update the `docs/` page, not this stub."
