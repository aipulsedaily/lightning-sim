# Please fork it

**This project is not accepting contributions, and is not maintained.**

That is not a brush-off. It was built as a single piece of work, it does
what it set out to do, and it is being published because it might be
useful or interesting to someone — not to start a project that needs
running. Issues and pull requests will most likely go unanswered, so
please do not spend your time on them.

What you are very welcome to do instead:

## Fork it

Press **Fork**, or just clone it and take the parts you want. The licence
is [MIT](LICENSE) — use it, change it, publish your version, sell something
built on it. No permission needed and no attribution beyond keeping the
copyright notice.

If you build something good on top, you owe nobody anything. Link back
only if you feel like it.

## Take pieces of it

The code is deliberately separable, so you do not have to adopt the whole
thing:

| You want | Take |
|---|---|
| The physics, with no renderer | `src/core/` — imports nothing from `src/render/`, runs headless under Node |
| Just the discharge growth | `src/core/leader.js` and `src/core/field.js` |
| Measured lightning constants, cited | `src/core/constants.js` |
| Photograph → 3-D reconstruction | `src/photo/` — only `scene.js` and `environment.js` touch three.js |
| Thunder from a channel geometry | `src/core/thunder.js` + `src/audio/thunderAudio.js` |
| The HDR bolt renderer | `src/render/bolt.js` + `src/render/post.js` |

There is no build step and no framework, so a file dropped into another
project generally just works.

## If you find something wrong

The physics is documented and sourced in [docs/PHYSICS.md](docs/PHYSICS.md),
and the places the model is knowingly off are listed under
[Honest limitations](docs/PHYSICS.md#honest-limitations). If you find a
real error, the most useful thing you can do is **fix it in your fork and
say so in your README** — that helps the next person far more than an
issue sitting unread here.

`tests/` holds plain Node scripts with no framework. `npm test` runs 54
checks of the simulation's outputs against published measurements, so if
you change the physics you will know quickly whether you broke it.
