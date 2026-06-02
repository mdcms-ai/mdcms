import { defineConfig, defineType, reference } from "@mdcms/cli";
import { z } from "zod";

import {
  studioExampleEnvironment,
  studioExampleLocales,
  studioExampleMdxComponents,
  studioExampleProject,
  studioExampleServerUrl,
} from "./lib/studio-example-studio-config";
import { getPreviewHrefForDocument } from "./lib/preview-routing";

const post = defineType("post", {
  directory: "content/posts",
  resolvePreviewUrl: getPreviewHrefForDocument,
  fields: {
    title: z.string().min(1),
    slug: z.string().min(1),
    featured: z.boolean().default(false).env("staging"),
    abTestVariant: z.string().min(1).optional().env("staging"),
    author: reference("author").optional(),
  },
});

const author = defineType("author", {
  directory: "content/authors",
  fields: {
    name: z.string().min(1),
  },
});

const page = defineType("page", {
  directory: "content/pages",
  resolvePreviewUrl: getPreviewHrefForDocument,
  fields: {
    title: z.string().min(1),
  },
});

const campaign = defineType("campaign", {
  directory: "content/campaigns",
  localized: true,
  fields: {
    title: z.string().min(1),
    slug: z.string().min(1),
    summary: z.string().min(1),
  },
});

export default defineConfig({
  project: studioExampleProject,
  environment: studioExampleEnvironment,
  serverUrl: studioExampleServerUrl,
  contentDirectories: ["content"],
  locales: studioExampleLocales,
  environments: {
    production: {},
    staging: {
      extends: "production",
    },
  },
  components: [...studioExampleMdxComponents],
  types: [post, author, page, campaign],
});
