# Historial de cambios

Los cambios importantes de Lienzo. El formato sigue
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y las versiones,
[Semantic Versioning](https://semver.org/lang/es/).

## [Sin publicar] -- 0.2.0, la primera versión publicada

### Agregado
- Editor de diseños local: páginas con formas, texto, imágenes y video; plantillas en
  proporciones; exportación a PNG, JPG, ZIP, PDF y video; fuentes de Google Fonts y propias;
  fotos de Openverse con crédito; IA local; quitar fondos lisos.
- Diseño para teléfono (pestañas abajo y paneles como hojas), Cambiar tamaño a otro formato,
  kit de marca y Dibujar a mano alzada.
- Guardado automático confiable en el editor, también al cerrar la pestaña.
- Registro de errores no capturados en `lienzo.log`, y un mensaje visible si la ventana no
  puede abrirse.
- Comprobación de versión nueva, apagada hasta que se configure un feed de versiones; con una
  versión nueva, el inicio muestra un aviso con el enlace de descarga.
- Integración continua (ruff, pruebas de Python y de JavaScript) y una auditoría de
  dependencias (`pip-audit`); Dependabot.
- Licencia MIT, `THIRD_PARTY_NOTICES.md` (incluido en el programa y en el instalador),
  `SECURITY.md` y una sección de privacidad en el README.

### Corregido
- Validación de tamaños de página, límite de píxeles al exportar y reversión de los archivos
  subidos si algo falla.
- Si falla la miniatura al guardar, se restaura el diseño anterior.
- El comando de pruebas de JavaScript del README corría solo uno de los dos archivos.
