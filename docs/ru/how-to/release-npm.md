# Выпуск CLI AIK в npm

[English version](../../how-to/release-npm.md)

Имя пилотного пакета — `agent-interface-kit`. Он устанавливает команду `aik` на macOS 15 или новее с Apple silicon. Используйте Node.js `>=26.13.1 <27`. CI выпуска использует Node.js 26.13.1 и npm 12.2.3.

## Проверка пакета

1. Откройте **Actions → npm release → Run workflow** на ветке `main`. Оставьте **publish** выключенным.
2. Дождитесь успешной сборки. Скачайте артефакт `aik-npm`. Он содержит тарбол и манифест с коммитом, версией пакета, списком файлов и SHA-256.
3. Для локальной проверки используйте новый каталог вывода и Mac с инструментами командной строки Xcode.

```sh
npm ci --ignore-scripts
node tools/pack-npm.mjs dist/npm
node tools/smoke-npm.mjs dist/npm/agent-interface-kit-0.1.0.tgz
```

Тарбол содержит пять рабочих пакетов зависимостей из исходного lock-файла. Проверка устанавливает его без сети с пустым кэшем npm, запускает `lock`, `compile` и `verify` с отключённой сетью и сравнивает байты lock-файла и результата с результатами CLI из исходников.

## Регистрация первого пакета

Владелец пакета MUST войти в npm и пройти проверки учётной записи. Используйте тарбол из принятой сборки GitHub. Для отправки на ручное подтверждение выполните `npm stage publish <tarball> --access public`, затем подтвердите публикацию в интерфейсе npm. Отправка нового пакета может создать публичную заглушку. Начинайте этот шаг после разрешения на выпуск.

[Публикация пакета npm](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/)

## Настройка Trusted Publishing

В настройках пакета npm откройте **Settings → Trusted publishing**. Добавьте GitHub Actions, разрешите `npm publish` и укажите следующие значения. Ограничьте окружение GitHub `npm` веткой `main`.

| Поле | Значение |
| --- | --- |
| Organization or user | `avksp` |
| Repository | `agent-interface-kit` |
| Workflow filename | `npm-release.yml` |
| Environment | `npm` |

Для следующего выпуска тег версии MUST указывать на тот же коммит `main`, который использует запуск. Запустите **npm release** с этого коммита с включённым **publish**. Workflow опубликует тарбол, прошедший проверку. Проверьте версию командой `npm view agent-interface-kit version` и установите эту версию на чистой поддерживаемой машине.

[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
