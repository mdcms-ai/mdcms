import { fetchPreviewPostBySlug } from "../../../../lib/preview-content";
import { PreviewDocumentView } from "../../preview-document-view";

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

  return await PreviewDocumentView({ heading: "Post Preview", result });
}
