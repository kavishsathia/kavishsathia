import Link from "next/link";
import { notFound } from "next/navigation";
import { getAllPosts, getPost } from "@/lib/blog";
import { Metadata } from "next";
import Markdown from "@/components/Markdown";
import TableOfContents from "@/components/TableOfContents";

type Props = { params: Promise<{ slug: string }> };

export async function generateStaticParams() {
  return getAllPosts().map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) return {};
  return { title: `${post.title} | Kavish Sathia` };
}

export default async function BlogPost({ params }: Props) {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) notFound();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <TableOfContents content={post.content} />
      <main className="mx-auto max-w-2xl px-6 py-24 sm:py-32">
        <Link
          href="/writing"
          className="font-mono text-sm text-muted hover:text-foreground transition-colors"
        >
          &larr; back
        </Link>

        <article className="mt-12">
          <time className="font-mono text-xs text-muted">{post.date}</time>
          <h1 className="text-3xl font-medium mt-2 mb-2">{post.title}</h1>
          {post.subtitle && (
            <p className="text-muted mb-8">{post.subtitle}</p>
          )}

          <div className="prose-custom mt-8">
            <Markdown content={post.content} />
          </div>
        </article>

        <div className="mt-24 flex justify-end">
          <span className="text-muted text-lg">∎</span>
        </div>
      </main>
    </div>
  );
}
