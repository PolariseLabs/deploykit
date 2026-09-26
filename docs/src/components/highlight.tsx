import type { ReactNode } from "react"

const token =
  /("[^"\n]*"|\/\/[^\n]*|\b(?:import|from|const|await|async|return|if|try|catch|yield|function|new)\b)/g

/** Minimal TypeScript highlighting for the landing page: keywords, strings, comments. */
export function highlight(code: string): ReactNode[] {
  return code.split(token).map((part, index) => {
    if (index % 2 === 0) return part
    const className = part.startsWith('"') ? "s" : part.startsWith("//") ? "c" : "k"
    return (
      <span key={index} className={className}>
        {part}
      </span>
    )
  })
}
