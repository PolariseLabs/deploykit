import { artifactFromFiles } from "@deploykit/node"
import { createClient } from "@deploykit/node/vercel"
import type { VercelOptions } from "@deploykit/node/vercel"

export async function publishGeneratedConfig(
  config: VercelOptions,
  input: { appId: string; operationId: string; title: string; logoFile: string }
) {
  const artifact = await artifactFromFiles([
    { path: ".vercel/output/config.json", text: '{"version":3}' },
    { path: ".vercel/output/static/index.html", text: "<h1>My site</h1>" },
    {
      path: ".vercel/output/static/config.json",
      text: JSON.stringify({ title: input.title })
    },
    { path: ".vercel/output/static/logo.png", file: input.logoFile }
  ])
  const client = createClient(config)
  try {
    return await client.deploy(input.appId, artifact, {
      operationId: input.operationId,
      target: "production",
      activation: "deferred"
    })
  } finally {
    await client.close()
  }
}
