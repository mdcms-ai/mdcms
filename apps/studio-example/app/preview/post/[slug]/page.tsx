import { fetchPreviewPostBySlug } from "../../../../lib/preview-content";
import { PreviewDocumentView } from "../../preview-document-view";

export const metadata = {
  title: "Post Preview | MDCMS Demo",
  description: "Preview a draft MDCMS post rendered through the SDK.",
};

type PostPreviewPageProps = {
  params: Promise<{
    slug: string;
  }>;
};

export default async function PostPreviewPage({
  params,
}: PostPreviewPageProps) {
  const { slug } = await params;
  const result = await fetchPreviewPostBySlug(slug);

  return <PreviewDocumentView heading="Post Preview" result={result} />;
}
