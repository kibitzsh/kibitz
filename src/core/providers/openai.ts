import * as https from 'https'
import { Provider, ModelId } from '../types'

export class OpenAIProvider implements Provider {
  async generate(
    systemPrompt: string,
    userPrompt: string,
    apiKey: string,
    model: ModelId,
    onChunk: (text: string) => void,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        model,
        max_tokens: 300,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        stream: true,
      })

      const req = https.request(
        {
          hostname: 'api.openai.com',
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            let errorBody = ''
            res.on('data', (d) => (errorBody += d))
            res.on('end', () => reject(new Error(`OpenAI API ${res.statusCode}: ${errorBody}`)))
            return
          }

          let full = ''
          let buffer = ''

          res.on('data', (chunk: Buffer) => {
            buffer += chunk.toString()
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const data = line.slice(6)
                if (data === '[DONE]') continue
                try {
                  const parsed = JSON.parse(data)
                  const delta = parsed.choices?.[0]?.delta?.content
                  if (delta) {
                    full += delta
                    onChunk(delta)
                  }
                } catch { /* skip malformed */ }
              }
            }
          })

          res.on('end', () => resolve(full))
          res.on('error', reject)
        },
      )

      req.on('error', reject)
      req.write(body)
      req.end()
    })
  }
}
