import { DeployDemo } from "../components/deploy-demo"
import { Examples } from "../components/examples"
import { InstallCommand } from "../components/install-command"

const facts = [
  {
    title: "Effect-native, with a Node API",
    body: "Typed errors, layers and interruption in Effect. The same API as Promises for plain Node."
  },
  {
    title: "Uploads the difference",
    body: "The host says what it already has. One changed file uploads one file."
  },
  {
    title: "Recover uncertain outcomes",
    body: "Lost create responses stay explicit. Reconcile them on supported providers."
  },
  {
    title: "Live when you say",
    body: "On Vercel, stage a build, check it, then activate. Provider capabilities stay explicit."
  },
  {
    title: "Errors with a next step",
    body: "Every failure says whether to retry, reconcile, wait or fix the input."
  },
  {
    title: "Bounded memory",
    body: "Stream from disk or object storage inside one shared budget."
  }
]

export default function Landing() {
  return (
    <div className="landing">
      <title>DeployKit</title>
      <meta
        name="description"
        content="Deploy your customers' sites from your own backend. Reuse cached content and keep control of activation and recovery."
      />

      <main className="page">
        <section className="hero">
          <h1 className="wordmark">DeployKit</h1>
          <p>
            The Effect-native SDK for deploying your customers&apos; sites.{" "}
            <span>Reuse cached content and keep control of activation and recovery.</span>
          </p>
          <div className="row">
            <a className="btn" href="/docs/installation">
              Get started
            </a>
            <InstallCommand command="bun add @deploykit/node@alpha" />
          </div>
        </section>

        <DeployDemo />

        <section className="facts">
          {facts.map(fact => (
            <div key={fact.title}>
              <b>{fact.title}</b>
              <span>{fact.body}</span>
            </div>
          ))}
        </section>

        <section className="section">
          <h2>Examples</h2>
          <Examples />
        </section>
      </main>
    </div>
  )
}

export const getConfig = () => ({ render: "static" }) as const
