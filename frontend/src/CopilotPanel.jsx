import { useCallback, useEffect, useRef, useState } from 'react'

const SUGGESTIONS_RU = [
  'Кого смотреть первым?',
  'Топ 5 по in_kzt',
  'Топ 10 консолидаторов',
  'Покажи карточку',
]

const SUGGESTIONS_EN = [
  'Who to review first?',
  'Top 5 by in_kzt',
  'Top 10 consolidators',
  'Show client card',
]

/**
 * Render answer text with clickable gid chips from `gids`.
 */
function AnswerBody({ answer, gids, onOpenGid }) {
  if (!answer) return null
  const set = new Set((gids || []).map(String))
  if (!set.size) {
    return <p className="copilot-text">{answer}</p>
  }

  // Split on 18-digit ids so we can wrap known ones as buttons
  const parts = String(answer).split(/(\d{18})/g)
  return (
    <p className="copilot-text">
      {parts.map((part, idx) => {
        if (set.has(part)) {
          return (
            <button
              key={`${part}-${idx}`}
              type="button"
              className="copilot-gid"
              onClick={() => onOpenGid(part)}
              title={part}
            >
              …{part.slice(-8)}
            </button>
          )
        }
        return <span key={idx}>{part}</span>
      })}
    </p>
  )
}

export default function CopilotPanel({
  selectedId,
  locale,
  labels,
  onOpenGid,
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [messages, setMessages] = useState([])
  const listRef = useRef(null)
  const suggestions = locale === 'en' ? SUGGESTIONS_EN : SUGGESTIONS_RU

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages, open, busy])

  const ask = useCallback(
    async (raw) => {
      const question = String(raw || '').trim()
      if (!question || busy) return
      if (question.length > 2000) return

      setDraft('')
      setMessages((prev) => [...prev, { role: 'user', text: question }])
      setBusy(true)

      try {
        const response = await fetch('/api/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            question,
            // gid must stay a string — Number() would lose precision on 18 digits
            selected_gid: selectedId != null ? String(selectedId) : null,
          }),
        })
        if (!response.ok) throw new Error('unavailable')
        const { answer, gids, mode } = await response.json()
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            text: answer || labels.emptyAnswer,
            gids: Array.isArray(gids) ? gids.map(String) : [],
            mode: mode === 'llm' ? 'llm' : 'rules',
          },
        ])
      } catch {
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            text: labels.unavailable,
            gids: [],
            mode: 'error',
          },
        ])
      } finally {
        setBusy(false)
      }
    },
    [busy, selectedId, labels],
  )

  const onSubmit = (e) => {
    e.preventDefault()
    ask(draft)
  }

  return (
    <div className={`copilot ${open ? 'open' : ''}`}>
      {!open ? (
        <button
          type="button"
          className="copilot-fab"
          onClick={() => setOpen(true)}
          title={labels.title}
        >
          {labels.fab}
        </button>
      ) : (
        <section className="copilot-panel" aria-label={labels.title}>
          <header className="copilot-head">
            <div>
              <strong>{labels.title}</strong>
              <span className="copilot-sub">
                {selectedId
                  ? labels.contextOn(`…${String(selectedId).slice(-8)}`)
                  : labels.contextOff}
              </span>
            </div>
            <button
              type="button"
              className="copilot-close"
              onClick={() => setOpen(false)}
              aria-label={labels.close}
            >
              ×
            </button>
          </header>

          <div className="copilot-hints">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                className="copilot-chip"
                disabled={busy}
                onClick={() => ask(s)}
              >
                {s}
              </button>
            ))}
          </div>

          <div className="copilot-messages" ref={listRef}>
            {messages.length === 0 && (
              <div className="copilot-empty">{labels.hint}</div>
            )}
            {messages.map((m, idx) => (
              <div key={idx} className={`copilot-msg ${m.role}`}>
                {m.role === 'user' ? (
                  <p className="copilot-text">{m.text}</p>
                ) : (
                  <>
                    {m.mode && m.mode !== 'error' && (
                      <span className={`copilot-mode ${m.mode}`}>
                        {m.mode === 'llm' ? labels.modeLlm : labels.modeRules}
                      </span>
                    )}
                    <AnswerBody
                      answer={m.text}
                      gids={m.gids}
                      onOpenGid={onOpenGid}
                    />
                    {m.gids?.length > 0 && (
                      <div className="copilot-gid-row">
                        {m.gids.map((g) => (
                          <button
                            key={g}
                            type="button"
                            className="copilot-gid"
                            onClick={() => onOpenGid(g)}
                            title={g}
                          >
                            …{g.slice(-8)}
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
            {busy && (
              <div className="copilot-msg assistant">
                <p className="copilot-text muted">{labels.thinking}</p>
              </div>
            )}
          </div>

          <form className="copilot-form" onSubmit={onSubmit}>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={labels.placeholder}
              disabled={busy}
              maxLength={2000}
              aria-label={labels.placeholder}
            />
            <button type="submit" disabled={busy || !draft.trim()}>
              {labels.send}
            </button>
          </form>
        </section>
      )}
    </div>
  )
}
