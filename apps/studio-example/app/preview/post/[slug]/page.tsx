import {
  createPreviewRequestUrl,
  fetchPreviewDocumentFromRequestUrl,
  type PreviewRouteSearchParams,
} from "../../../../lib/preview-content";
import { PreviewDocumentView } from "../../preview-document-view";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Post Preview | MDCMS Demo",
  description: "Preview a draft MDCMS post rendered through the SDK.",
};

type PostPreviewPageProps = {
  params: Promise<{
    slug: string;
  }>;
  searchParams?: Promise<PreviewRouteSearchParams>;
};

export default async function PostPreviewPage({
  params,
  searchParams,
}: PostPreviewPageProps) {
  const { slug } = await params;
  const result = await fetchPreviewDocumentFromRequestUrl(
    createPreviewRequestUrl(
      `/preview/post/${encodeURIComponent(slug)}`,
      await searchParams,
    ),
  );

  return PreviewDocumentView({ heading: "Post Preview", result });
}
