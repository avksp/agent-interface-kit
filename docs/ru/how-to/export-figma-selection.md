# Экспорт выделения из Figma Design

[English version](../../how-to/export-figma-selection.md)

Для сборки плагина разработки используйте Figma Desktop и рабочую копию исходников AIK. Используйте AIK CLI 0.1.0 на macOS arm64 с Node.js 26.13.1 или более поздней версией 26.x. Установите CLI командой `npm install -g agent-interface-kit@0.1.0`.

## Сборка и импорт

1. В файле Figma Design откройте **Plugins → Development → New plugin**. Создайте плагин Design и скопируйте идентификатор из созданного файла `manifest.json`.
2. Выполните команды ниже в рабочей копии AIK. Замените `<figma-id>` идентификатором. Используйте пустую папку для сборки.
3. В Figma Desktop откройте **Plugins → Development → Import plugin from manifest**. Выберите `dist/figma-exporter/manifest.json`.

```sh
npm ci
npm run build --workspace @aik/figma-exporter -- --plugin-id '<figma-id>' --out dist/figma-exporter
```

[Справочник по манифесту Figma](https://developers.figma.com/docs/plugins/manifest/)

## Экспорт и компиляция

1. Выделите один видимый фрейм с Auto Layout непосредственно на текущей странице. Откройте **Plugins → Development → AIK Figma Exporter**.
2. Если во фрейме есть изображение, введите его альтернативный текст. Нажмите **Capture selection**, затем **Save ZIP**.
3. Распакуйте ZIP в новую локальную папку. Храните `snapshot.json`, `overlay.json` и необязательную папку `assets/` вместе.
4. Выполните команды ниже в родительской папке распакованного каталога `capture`. Каталог временных файлов ДОЛЖЕН быть приватным, без расширенных ACL и на том же томе, что и `capture`. Используйте новый путь для `site`.

```sh
mkdir -m 700 staging
aik lock --input ./capture --overlay ./capture/overlay.json --out ./capture/build.lock.json --staging-root "$(pwd -P)/staging"
aik compile --lock ./capture/build.lock.json --out ./site
aik verify --manifest ./site/artifact-manifest.json
```

Экспортёр поддерживает горизонтальный и вертикальный Auto Layout, вложенные фреймы, текст в одном обычном начертании и прямоугольники с однотонной заливкой. Фрейм МОЖЕТ содержать один прямоугольник с изображением размером до 512 на 512 пикселей. Для каждого экспорта с изображением заново введите альтернативный текст длиной до 200 кодовых единиц UTF-16. Отключите перенос элементов и обрезку. Используйте простые заливки и удалите привязанные стили, переменные, маски, эффекты и обводки на видимых слоях. Плагин отклоняет неподдерживаемые видимые слои и не изменяет макет. Figma может выделить память под список слоёв или текст до того, как экспортёр применит ограничения. Если выделение изменилось во время экспорта, выделите фрейм и повторите попытку.

[Зафиксировать снимок](lock-capture.md) · [Опубликовать плагин AIK](publish-figma-plugin.md)
