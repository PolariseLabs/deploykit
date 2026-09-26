"use client"

import { useEffect, useState } from "react"

/** The install command with a copy button that shows a tick for a moment. */
export function InstallCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const copy = () => {
    navigator.clipboard.writeText(command).then(
      () => setCopied(true),
      () => {}
    )
  }

  return (
    <div className="install">
      <code>{command}</code>
      <button
        type="button"
        onClick={copy}
        className={copied ? "copied" : undefined}
        aria-label={copied ? "Copied" : "Copy install command"}
      >
        <svg
          key={copied ? "tick" : "copy"}
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          {copied ? (
            <path d="M20 6 9 17l-5-5" />
          ) : (
            <>
              <rect x="9" y="9" width="12" height="12" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </>
          )}
        </svg>
      </button>
    </div>
  )
}
