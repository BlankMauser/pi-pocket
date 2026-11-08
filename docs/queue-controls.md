# Queue and agent controls

[Messages](#messages) · [Agents](#agents)

## Messages

**Steer all** moves your waiting messages to the next model step together. An idle session resumes in the same conversation. **Interrupt + send all** stops the current run and sends your selected messages together, in queue order. A second tap confirms the interrupt.

The composer's **Interrupt**, an individual queued message's **Interrupt now**, and the bulk interrupt all keep other pending messages. Their original order, sender, queue mode and submission IDs stay intact. Subagent reports and persistent children's queues are preserved too. Bulk controls affect only messages you wrote; they do not consume someone else's messages or reports.

**Stop** is separate: it withdraws the stopped conversation's queued inputs and cancels a pending interrupt. Interrupting a parent does not stop its persistent children.

## Agents

An agent can use `subagent` action `interrupt` with an existing child's `name` and revised `message`. This stops that child's current run, sends the new instructions in the same conversation, and retains its context and pending messages. `send` remains a steer by default; `followUp: true` waits until the answer ends.

The `team` tool also exposes `stop` and `archive`. An archive with `archived: false` restores the linked session. These calls check session access and current policy; replaying a completed stop cannot stop a newer run.

<details>
<summary>Example agent calls</summary>

```json
{
    "action": "interrupt",
    "name": "build-helper",
    "message": "Keep your current context. Check the changed files before building."
}
```

```json
{ "action": "stop", "to": "linked-session-address" }
```

```json
{ "action": "archive", "to": "linked-session-address", "archived": false }
```

The first call uses `subagent`; the others use `team`.

</details>
