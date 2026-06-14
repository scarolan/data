// Image generation via Gemini (Nano Banana). Client and model are injected
// so the unit tests can substitute a fake without making API calls.

export const SLACK_FILE_SIZE_WARN_BYTES = 5 * 1024 * 1024;

export async function generateImage(prompt, { client, model }) {
  if (!prompt || prompt.trim() === '') {
    throw new Error('Empty prompt provided for image generation');
  }
  if (!client) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  console.log(`Generating Gemini image with model "${model}", prompt: "${prompt}"`);

  const response = await client.models.generateContent({ model, contents: prompt });

  const parts = response?.candidates?.[0]?.content?.parts;
  const imagePart = parts?.find((p) => p.inlineData?.data);

  if (!imagePart) {
    const textPart = parts?.find((p) => p.text)?.text;
    console.error('No image data in Gemini response. Text returned:', textPart);
    throw new Error(textPart || 'Received invalid response from image generation API');
  }

  const imageBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
  const fileSizeKB = (imageBuffer.length / 1024).toFixed(2);
  console.log(`Image generated successfully, size: ${fileSizeKB}KB`);

  if (imageBuffer.length > SLACK_FILE_SIZE_WARN_BYTES) {
    console.warn(
      `WARNING: Generated image is very large (${fileSizeKB}KB), may exceed Slack limits`
    );
  }

  return imageBuffer;
}
