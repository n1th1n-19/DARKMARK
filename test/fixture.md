# darkmark v2 fixture

Open this in VS Code with darkmark to check every v2 feature by hand.

## Images

Relative to parent: ![logo](../media/logo.png)

Subfolder with a space in the name: ![logo](assets/logo%20with%20space.png)

Raw HTML: <img src="assets/logo with space.png" width="64">

Remote: ![badge](https://img.shields.io/badge/darkmark-v2-bc8cff)

## Video and audio

Markdown syntax: ![clip](assets/clip.webm)

Raw HTML:

<video controls width="320"><source src="assets/clip.webm" type="video/webm"></video>

Audio: ![tone](assets/tone.mp3)

YouTube:

<iframe width="420" height="236" src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" allowfullscreen></iframe>

## Task list

- [ ] todo
- [x] done
- plain item

## Math

Inline $x_1^2 + y_1^2 = r^2$ and a block:

$$
\int_0^\infty e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}
$$

## Mermaid

```mermaid
graph LR
  A[Markdown] --> B{darkmark}
  B --> C[Preview]
```

## Code

```ts
const answer: number = 42; // hover → Copy
```

## Links

- [Jump to Math](#math)
- [Duplicate heading](#links-1)
- [Other markdown file](./other.md)
- [Non-markdown file](../package.json)
- [Website](https://github.com/n1th1n-19/DARKMARK)

## Links

Second "Links" heading → id `links-1`.
