import { defineConfig } from "fumapress"
import { fumadocsMdx } from "fumapress/adapters/mdx"
import { metaSchema, pageSchema } from "fumapress/adapters/mdx/schema"
import { defineDocs } from "fumadocs-mdx/macro"

// see https://fumadocs.dev/docs/mdx
const docs = defineDocs({
  dir: "content",
  docs: {
    async: true,
    schema: pageSchema,
    lastModified: true,
    postprocess: {
      includeProcessedMarkdown: true
    }
  },
  meta: {
    schema: metaSchema
  }
})

export default defineConfig({
  content: docs.toFumadocsSource(),
  site: {
    name: "DeployKit",
    baseUrl: process.env.DEPLOYKIT_DOCS_URL
  },
  defaultLayoutProps: {
    nav: {
      title: (
        <span className="wordmark" style={{ fontSize: 20 }}>
          DeployKit
        </span>
      ),
      url: "/"
    }
  }
}).adapters(fumadocsMdx())
