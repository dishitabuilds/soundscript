import { useEffect, useRef, useState } from "react";
import { askDocument, getStudyStatus, prepareStudy } from "./api";

export default function StudyAssistant({ documentId, onSeek, canPlay }) {
  const [status, setStatus] = useState(null);
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [sourceOnly, setSourceOnly] = useState(false);
  const request = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    getStudyStatus(documentId, controller.signal)
      .then(setStatus)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => {
      controller.abort();
      request.current?.abort();
    };
  }, [documentId]);

  async function prepare() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy("prepare");
    setError("");
    try {
      await prepareStudy(documentId, controller.signal);
      setStatus(await getStudyStatus(documentId, controller.signal));
    } catch (e) {
      if (e.name !== "AbortError") setError(e.message);
    } finally {
      if (!controller.signal.aborted) setBusy("");
    }
  }

  async function ask(event) {
    event.preventDefault();
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy("ask");
    setError("");
    setResult(null);
    try {
      setResult(
        await askDocument(
          documentId,
          question.trim(),
          {
            mode: status.ready ? "hybrid" : "keyword",
            rerank: status.reranking,
            generate: !sourceOnly,
          },
          controller.signal,
        ),
      );
    } catch (e) {
      if (e.name !== "AbortError") setError(e.message);
    } finally {
      if (!controller.signal.aborted) setBusy("");
    }
  }

  if (!status && !error) return null;
  return (
    <section
      aria-labelledby="study-title"
      className="bg-surface border border-line rounded-2xl p-6 mb-6"
    >
      <h2 id="study-title" className="font-display text-xl mb-2">
        Ask your document
      </h2>
      <p className="text-soft text-sm mb-4">
        Explore an idea, check an explanation, or find a passage to listen to.
      </p>
      {status && !status.ready && status.reranking && (
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <button
            type="button"
            onClick={prepare}
            disabled={Boolean(busy)}
            className="px-4 py-2 rounded-lg border border-line bg-sunken disabled:opacity-50"
          >
            {busy === "prepare"
              ? "Preparing search…"
              : "Prepare meaning-based search"}
          </button>
          <span className="text-soft text-xs">
            Keyword search is available now.
          </span>
        </div>
      )}
      {status && (
        <form onSubmit={ask} className="space-y-3">
          <label htmlFor="study-question" className="block text-sm font-medium">
            Your question
          </label>
          <textarea
            id="study-question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={2}
            minLength={3}
            maxLength={1000}
            required
            placeholder="What is the main argument in this document?"
            className="w-full rounded-lg border border-line bg-page text-ink p-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold"
          />
          {status.generation && (
            <label className="flex items-center gap-2 text-sm text-soft">
              <input
                type="checkbox"
                checked={sourceOnly}
                onChange={(event) => setSourceOnly(event.target.checked)}
              />
              Show source passages only
            </label>
          )}
          <button
            disabled={Boolean(busy) || question.trim().length < 3}
            className="px-4 py-2 rounded-lg bg-gold text-on-gold font-medium disabled:opacity-50"
          >
            {busy === "ask" ? "Finding evidence…" : "Ask question"}
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-danger text-sm mt-4">
          {error}
        </p>
      )}
      <div aria-live="polite" aria-busy={busy === "ask"}>
        {result && (
          <div className="mt-5 border-t border-line pt-4">
            <p className="text-xs text-soft mb-2">
              {result.mode === "generated"
                ? "Answer from your document"
                : "Source search results"}
            </p>
            <p className="whitespace-pre-wrap leading-relaxed">
              {result.answer}
            </p>
            {result.citations.map((citation) => (
              <article
                key={citation.id}
                className="mt-4 border-l-2 border-line pl-4"
              >
                <p className="text-xs text-soft mb-1">
                  Source {citation.label} · Paragraph {citation.paragraph}
                </p>
                <blockquote className="text-sm leading-relaxed">
                  {citation.text}
                </blockquote>
                {canPlay && citation.startSeconds !== null && (
                  <button
                    type="button"
                    onClick={() => onSeek(citation.startSeconds)}
                    className="mt-2 text-sm text-gold underline underline-offset-2"
                  >
                    Listen to this paragraph
                  </button>
                )}
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
