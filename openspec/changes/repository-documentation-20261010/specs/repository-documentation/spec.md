## ADDED Requirements
### Requirement: Repository directory guide
The system SHALL document frontend, backend, Worker, deployment, dependency and generated-output directory responsibilities.

#### Scenario: Find frontend source
- **WHEN** a reader opens the repository guide
- **THEN** src/ is identified as frontend source and dist/ as generated output

### Requirement: Explicit source map catalog
The document center SHALL expose only source maps registered in the chapter catalog, with existing authentication, save protection and containment checks.

#### Scenario: Read a registered map
- **WHEN** a signed-in reader selects a present registered source map
- **THEN** its content is displayed and relative document links remain navigable

#### Scenario: Reject an unregistered map
- **WHEN** a reader requests an unregistered codemap or a symlinked source map
- **THEN** the request is rejected
