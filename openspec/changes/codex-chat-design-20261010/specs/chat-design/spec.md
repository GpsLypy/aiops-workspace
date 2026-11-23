## ADDED Requirements

### Requirement: Conversation workspace
The chat view SHALL provide a compact header and a distinct conversation sidebar with direct navigation to resources, documents and guidance, while retaining original branding.

#### Scenario: Search existing conversations
- **WHEN** the user searches recent conversations
- **THEN** only their matching conversation summaries SHALL appear without sending chat or model requests

#### Scenario: Collapsed and mobile navigation
- **WHEN** the sidebar is collapsed or the viewport is narrow
- **THEN** navigation SHALL remain available by keyboard and SHALL NOT remount the active chat merely to open it

### Requirement: Continuous answer reading
The chat view SHALL render user messages as right-aligned bubbles and assistant answers as readable unboxed text, preserving execution status and evidence.

#### Scenario: Read earlier messages
- **WHEN** the user scrolls away from the latest message
- **THEN** incoming text SHALL NOT force scrolling and a return-to-latest action SHALL restore following

#### Scenario: Inspect panorama during completion
- **WHEN** an answer completes while its execution panorama is open
- **THEN** the live trace SHALL be replaced together with the final message so the viewer remains open with the persisted history trace

### Requirement: Unified composer
The composer SHALL contain knowledge and independent-review controls, Agent and effort choices, attachment and send-or-stop actions, with bounded draft height and visible keyboard focus.

#### Scenario: Narrow viewport and generation
- **WHEN** the viewport is 320 pixels wide or generation is active
- **THEN** controls SHALL remain within the viewport and generation SHALL retain the existing stop and review-gate behavior

#### Scenario: Prompt starter
- **WHEN** the user selects a starter
- **THEN** it SHALL fill and focus the draft without submitting a model request
