import { config } from '../config';
import { AppError } from '../middleware/error-handler';

// ==========================================
// Force AI v1 Service
// AI-powered content generation for e-commerce
// ==========================================

export interface ProductDescriptionInput {
  name: string;
  category?: string;
  features?: string[];
  targetAudience?: string;
  tone?: 'professional' | 'casual' | 'luxury' | 'playful';
  length?: 'short' | 'medium' | 'long';
}

export interface SEOInput {
  productName: string;
  description: string;
  category?: string;
  keywords?: string[];
}

export interface MarketingCopyInput {
  productName: string;
  description: string;
  promoType: 'sale' | 'new_arrival' | 'limited_edition' | 'seasonal' | 'general';
  discount?: number;
  platform?: 'email' | 'social' | 'banner' | 'push';
}

export interface AIGenerationResult {
  content: string;
  tokens_used?: number;
  model?: string;
}

export class AIService {
  private static readonly API_ENDPOINT = config.aiApiEndpoint || 'https://api.anthropic.com/v1/messages';
  private static readonly API_KEY = config.aiApiKey || '';
  private static readonly MODEL = 'claude-3-haiku-20240307';

  /**
   * Check if AI service is available
   */
  static isAvailable(): boolean {
    return !!this.API_KEY;
  }

  /**
   * Generate product description
   */
  static async generateProductDescription(input: ProductDescriptionInput): Promise<AIGenerationResult> {
    const { name, category, features, targetAudience, tone = 'professional', length = 'medium' } = input;

    const lengthGuide = {
      short: '50-100 words',
      medium: '150-200 words',
      long: '250-350 words',
    };

    const toneGuide = {
      professional: 'professional and informative',
      casual: 'friendly and approachable',
      luxury: 'sophisticated and premium',
      playful: 'fun and engaging',
    };

    const prompt = `Generate a compelling product description for an e-commerce listing.

Product Name: ${name}
${category ? `Category: ${category}` : ''}
${features?.length ? `Key Features: ${features.join(', ')}` : ''}
${targetAudience ? `Target Audience: ${targetAudience}` : ''}

Requirements:
- Tone: ${toneGuide[tone]}
- Length: ${lengthGuide[length]}
- Include benefits, not just features
- Use persuasive language
- Make it scannable with short paragraphs
- Do not use clichés or overused phrases
- Do not include any headings or titles

Return ONLY the product description text, no additional commentary.`;

    return this.callAI(prompt);
  }

  /**
   * Generate SEO meta tags
   */
  static async generateSEO(input: SEOInput): Promise<{
    metaTitle: string;
    metaDescription: string;
    keywords: string[];
  }> {
    const { productName, description, category, keywords = [] } = input;

    const prompt = `Generate SEO-optimized meta tags for an e-commerce product page.

Product Name: ${productName}
Description: ${description}
${category ? `Category: ${category}` : ''}
${keywords.length ? `Existing Keywords: ${keywords.join(', ')}` : ''}

Requirements:
1. Meta Title: 50-60 characters, include product name and key benefit
2. Meta Description: 150-160 characters, compelling and action-oriented
3. Keywords: 5-10 relevant search terms

Return the response in this exact JSON format:
{
  "metaTitle": "...",
  "metaDescription": "...",
  "keywords": ["keyword1", "keyword2", ...]
}

Return ONLY the JSON, no additional text or markdown.`;

    const result = await this.callAI(prompt);

    try {
      const parsed = JSON.parse(result.content);
      return {
        metaTitle: parsed.metaTitle || '',
        metaDescription: parsed.metaDescription || '',
        keywords: parsed.keywords || [],
      };
    } catch {
      throw new AppError(500, 'AI_PARSE_ERROR', 'Failed to parse AI response');
    }
  }

  /**
   * Generate marketing copy
   */
  static async generateMarketingCopy(input: MarketingCopyInput): Promise<{
    headline: string;
    body: string;
    cta: string;
  }> {
    const { productName, description, promoType, discount, platform = 'general' } = input;

    const platformGuide: Record<string, string> = {
      email: 'email marketing - can be slightly longer, include subject line',
      social: 'social media - punchy, under 280 characters for the main text',
      banner: 'website banner - ultra concise, maximum impact',
      push: 'push notification - under 100 characters',
      general: 'general marketing - balanced length and tone',
    };

    const promoGuide = {
      sale: `${discount ? `${discount}% off` : 'Sale'} promotion`,
      new_arrival: 'New product launch',
      limited_edition: 'Limited edition/scarcity focus',
      seasonal: 'Seasonal/holiday promotion',
      general: 'General awareness',
    };

    const prompt = `Generate marketing copy for an e-commerce promotion.

Product: ${productName}
Description: ${description}
Promotion Type: ${promoGuide[promoType]}
${discount ? `Discount: ${discount}%` : ''}
Platform: ${platformGuide[platform]}

Requirements:
1. Headline: Attention-grabbing, creates urgency or curiosity
2. Body: Highlights key value proposition
3. CTA (Call to Action): Clear, action-oriented button text

Return the response in this exact JSON format:
{
  "headline": "...",
  "body": "...",
  "cta": "..."
}

Return ONLY the JSON, no additional text or markdown.`;

    const result = await this.callAI(prompt);

    try {
      const parsed = JSON.parse(result.content);
      return {
        headline: parsed.headline || '',
        body: parsed.body || '',
        cta: parsed.cta || '',
      };
    } catch {
      throw new AppError(500, 'AI_PARSE_ERROR', 'Failed to parse AI response');
    }
  }

  /**
   * Improve existing text
   */
  static async improveText(text: string, goal: 'clarity' | 'engagement' | 'seo' | 'conciseness'): Promise<AIGenerationResult> {
    const goalGuide = {
      clarity: 'Make the text clearer and easier to understand',
      engagement: 'Make the text more engaging and persuasive',
      seo: 'Optimize the text for search engines while keeping it natural',
      conciseness: 'Make the text more concise without losing meaning',
    };

    const prompt = `Improve the following text.

Original text:
"${text}"

Goal: ${goalGuide[goal]}

Requirements:
- Maintain the original meaning and intent
- Keep the same general structure
- Do not add new information
- Return only the improved text, no explanations

Improved text:`;

    return this.callAI(prompt);
  }

  /**
   * Generate category description
   */
  static async generateCategoryDescription(
    categoryName: string,
    productTypes: string[]
  ): Promise<AIGenerationResult> {
    const prompt = `Write a brief category description for an e-commerce website.

Category Name: ${categoryName}
Types of products in this category: ${productTypes.join(', ')}

Requirements:
- 2-3 sentences
- Highlight what customers can find in this category
- Use inviting language
- Do not start with "Welcome to" or similar clichés

Return ONLY the category description text.`;

    return this.callAI(prompt);
  }

  /**
   * Call the AI API
   */
  private static async callAI(prompt: string): Promise<AIGenerationResult> {
    if (!this.isAvailable()) {
      // Return mock response in development without API key
      if (config.nodeEnv === 'development') {
        return {
          content: this.getMockResponse(prompt),
          tokens_used: 0,
          model: 'mock',
        };
      }
      throw new AppError(503, 'AI_UNAVAILABLE', 'AI service is not configured');
    }

    try {
      const response = await fetch(this.API_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.MODEL,
          max_tokens: 1024,
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('[AI ERROR]', error);
        throw new AppError(502, 'AI_API_ERROR', 'Failed to generate content');
      }

      const data = await response.json() as {
        content: Array<{ text: string }>;
        usage?: { output_tokens: number };
        model: string;
      };

      return {
        content: data.content[0]?.text || '',
        tokens_used: data.usage?.output_tokens,
        model: data.model,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      console.error('[AI ERROR]', error);
      throw new AppError(502, 'AI_API_ERROR', 'Failed to connect to AI service');
    }
  }

  /**
   * Get mock response for development
   */
  private static getMockResponse(prompt: string): string {
    if (prompt.includes('product description')) {
      return 'Experience premium quality with our carefully crafted product. Designed with attention to detail, this item combines functionality with style. Perfect for everyday use, it delivers exceptional performance while maintaining a sleek, modern aesthetic. Upgrade your collection today.';
    }
    if (prompt.includes('SEO')) {
      return JSON.stringify({
        metaTitle: 'Premium Quality Product | Shop Now',
        metaDescription: 'Discover our premium product. High quality, great value. Free shipping available. Shop now!',
        keywords: ['premium', 'quality', 'shop', 'buy', 'best'],
      });
    }
    if (prompt.includes('marketing copy')) {
      return JSON.stringify({
        headline: 'Limited Time Offer',
        body: 'Get the quality you deserve at a price you will love.',
        cta: 'Shop Now',
      });
    }
    if (prompt.includes('category description')) {
      return 'Explore our curated selection of premium products. Find exactly what you need with our diverse range of high-quality items.';
    }
    return 'AI-generated content would appear here.';
  }
}
