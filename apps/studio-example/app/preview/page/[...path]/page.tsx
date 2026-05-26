import { fetchPreviewPageByPath } from "../../../../lib/preview-content";
import { PreviewDocumentView } from "../../preview-document-view";

type PagePreviewPageProps = {
  params: Promise<{
    path: string[];
  }>;
};

export default async function PagePreviewPage({
  params,
}: PagePreviewPageProps) {
  const { path } = await params;
  const result = await fetchPreviewPageByPath(path);

  return <PreviewDocumentView heading="Page Preview" result={result} />;
}
