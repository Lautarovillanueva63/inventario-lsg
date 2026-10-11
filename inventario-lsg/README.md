# Inventario de Obra LSG

Sistema web para saber **qué herramientas y materiales hay en cada ubicación** (depósito central y obras), con remitos internos numerados que firma el capataz que recibe.

## Cómo funciona

- **Herramientas y equipos:** cada unidad es única y tiene un código automático (`TRO-001 · Trompo hormigonero 1`). Está siempre en un solo lugar: si la movés, desaparece del origen y aparece en el destino.
- **Materiales:** se manejan por cantidad (bolsas, barras, m³…). Al moverlos se restan del origen y se suman al destino.
- **El remito es el comprobante del movimiento**, no el inventario en sí.

### Las 4 acciones (solo admin)

| Acción | Para qué | ¿Genera remito LSG? |
|---|---|---|
| **Cargar lo que ya hay** | Dar de alta lo que ya tienen hoy, sin papeles | No |
| **Ingreso de proveedor** | Lo que llega de un proveedor, con su N° de remito y foto | No (se adjunta el del proveedor) |
| **Mover con remito** | Del depósito a una obra, de obra a obra o de vuelta al depósito | **Sí:** `R-00001`, original y duplicado para firmar |
| **Consumo o baja** | Materiales usados en obra, o herramientas rotas o perdidas | No |

### Flujo de un remito
1. **Mover con remito** → elegís origen, destino, tildás las herramientas, ponés cantidades de materiales y escribís quién recibe (el capataz).
2. Al confirmar, los ítems ya cambian de ubicación y se genera el remito numerado.
3. **Imprimir remito** → sale el original y el duplicado en A4, con firmas de entrega y recepción. También se puede guardar como PDF desde la ventana de impresión.
4. El capataz firma. **Subir remito firmado** → le sacás una foto y queda adjunta.
5. Mientras falte la foto, la obra muestra el aviso "remito sin firma".

Un movimiento **no se puede editar ni borrar**: es el registro histórico. Si hubo un error, se corrige con otro movimiento (por ejemplo, un remito de vuelta).

### El remito impreso
- Tiene el mismo formato que el remito en papel de LSG: datos de la empresa, CUIT, IIBB, tabla Cantidad / Código / Descripción, origen, destino, nota y "Recibí conforme" con aclaración y DNI del capataz.
- Sale en dos hojas: **Original** y **Duplicado**.
- El recuadro de la letra va **en blanco**. La "R" (Cód. 91) corresponde al remito fiscal autorizado por ARCA: antes de usarla, consultalo con el contador.
- **Logo:** poné el logo de LSG como `logo.png` en la carpeta del proyecto y aparece solo en el remito. Si no está, se usa un logo de texto.
- **Datos de la empresa:** están en `app.js`, en el bloque `EMPRESA` (dirección, teléfono, CUIT, letra, etc.). Si cambia algo, se edita solo ahí.

### Cierre de obra
1. En la obra, tocá **Finalizar obra**.
2. Si todavía tiene herramientas o materiales, no deja cerrarla: ofrece **Devolver todo al depósito** (arma el remito con todo tildado) o **Registrar consumo** de lo que se usó.
3. Con la obra vacía, **Finalizar obra** la pasa a la sección **Obras finalizadas** y abre el **informe de cierre** para guardarlo en PDF.
4. No se borra nada: remitos, fotos firmadas, ingresos y consumos quedan guardados. Si hace falta, se reabre desde **Reabrir / editar**.

### Informe de obra
Botón **Informe de obra** (también para lectores), en cualquier momento. Incluye:
- **Herramientas:** cada una que pasó por la obra, cuándo llegó y cuándo se fue (con su remito).
- **Materiales:** recibido, enviado, consumido y saldo.
- **Remitos:** número, fecha, quién recibió y si está firmado.
- **Ingresos de proveedor, altas, consumos y bajas** con su motivo.

Se imprime o se guarda como PDF desde la ventana de impresión.

## Vehículos (pestaña aparte)

Usa los mismos usuarios y las mismas obras, pero tiene sus propias tablas: no toca nada del inventario.

**Instalación:** en Supabase → SQL Editor, corré `vehiculos.sql` (después de `supabase.sql`). Se puede volver a correr sin perder datos.

**Qué tiene:**
- **Ficha de cada vehículo:** patente, modelo, combustible, rendimiento de referencia (km/l), chofer y obra donde trabaja.
- **Vencimientos con semáforo:** VTV, seguro, patente, RUTA y registro del chofer. Amarillo si vence en menos de 30 días, rojo si está vencido. Cada renovación queda en el historial.
- **Services:** próximo service por km o por fecha (lo que llegue primero). Solo los de tipo "Service" reinician el contador.
- **Cargas de combustible:** una por una, o todo el **resumen de la tarjeta de flota** de una vez. El odómetro es obligatorio y se controla que no vaya para atrás.
- **Rendimiento:** km entre cargas ÷ litros. Alerta si da más de 15 % peor que la referencia.
- **Gasto por obra:** litros, pesos y km imputados a cada obra por mes, con **viajes equivalentes** = km ÷ (2 × distancia de ida). Las distancias se cargan una vez, en "Distancias de las obras".
- **Para atender:** arriba de todo, la lista de vencimientos, services y consumos fuera de lo normal.

Solo los admins cargan datos; los lectores ven todo.

## Novedades

- **Remito:** sale la descripción de cada herramienta (marca/modelo); aclaración y DNI quedan en blanco para completar a mano.
- **Fotos:** cada herramienta y material puede tener una foto. Se ve chiquita en las tablas y en la ficha; tocándola se amplía. Con el lápiz se cambia (en el celular abre la cámara) y con el tacho se quita.
- **Vehículos y maquinaria:**
  - **Cargar flota:** varios vehículos de una vez.
  - **Por km o por horas:** las máquinas con horómetro calculan el service por horas y el consumo en litros por hora.
  - **Actualizar km / horas:** anotás lo que marca hoy cada vehículo, sin esperar una carga. Avisa si un dato no se actualiza hace más de 30 días.
  - **Documentos:** póliza, VTV, cédula, título, etc. en PDF o foto, por vehículo.
  - **PDF:** "Ficha en PDF" de cada vehículo (estado, vencimientos, consumo, cargas y services) y "Toda la flota (PDF)". En el celular abre el menú de compartir (WhatsApp, mail); en la compu lo descarga.
  - **Consumo de referencia:** si lo dejás vacío, el sistema usa el **promedio propio** del vehículo (últimos 6 meses, con al menos 3 tramos entre cargas).

## Empezar de cero después de las pruebas

1. Supabase → **SQL Editor** → pegá `reset.sql` → **Run**.
   - Borra herramientas, materiales, remitos, obras y vehículos.
   - **Conserva** usuarios, roles y los depósitos (con el nombre que tengan).
   - La numeración vuelve a R-00001 y los códigos a 001.
2. Las fotos se borran aparte: **Storage → remitos** → seleccionar todo → **Delete**.

## Publicar en internet (GitHub privado + Netlify)

1. En github.com: **New repository** → nombre `inventario-lsg` → **Private** → Create.
2. Subí los archivos de esta carpeta (incluido `config.js`): botón **uploading an existing file**, arrastrás todo y **Commit changes**. O con Git:
   ```bash
   git init
   git add .
   git commit -m "Inventario LSG"
   git branch -M main
   git remote add origin https://github.com/TU-USUARIO/inventario-lsg.git
   git push -u origin main
   ```
3. En netlify.com: **Add new site → Import an existing project → GitHub** → autorizá el repo privado → elegilo.
4. Build command: vacío. Publish directory: vacío. **Deploy**.
5. **Site configuration → Change site name** → `inventario-lsg` → queda `https://inventario-lsg.netlify.app`.
6. Abrí ese link en el celular e ingresá. Cada `git push` (o archivo nuevo subido a GitHub) se publica solo.

**¿Qué queda guardado?** En el código solo está la clave **pública** de Supabase (`config.js`), que está pensada para estar a la vista: la seguridad la dan el login y las reglas de la base. Las contraseñas no están en ningún archivo. En cada dispositivo la sesión queda abierta hasta tocar **Salir**.

## Usuarios y permisos

| Rol | Qué puede hacer |
|---|---|
| **admin** | Todo: obras, altas, ingresos, remitos, consumos, fotos, renombrar herramientas |
| **lector** | Ver todo (inventario, remitos, fotos, historial), sin modificar nada |

Los permisos los controla la **base de datos**, no solo la página:
- El inventario solo cambia a través de la función `registrar_movimiento`, así nunca hay un cambio de stock sin su movimiento registrado. Ni siquiera un admin puede mover una herramienta "a mano" saltándose el remito.
- Esa función es **todo o nada**: si un ítem falla (por ejemplo, no alcanza el stock), no se mueve ninguno.

## Archivos

| Archivo | Qué hace |
|---|---|
| `index.html` | La estructura de la página |
| `styles.css` | El diseño, incluido el del remito impreso |
| `app.js` | La lógica de la página |
| `config.js` | La URL y la clave pública de tu proyecto de Supabase |
| `supabase.sql` | Crea las tablas, la función de movimientos, la seguridad y el lugar para las fotos |
| `flota.js` | La pestaña de vehículos |
| `vehiculos.sql` | Las tablas de vehículos (se corre después de `supabase.sql`) |
| `reset.sql` | Borra los datos de prueba para empezar de cero (conserva usuarios) |

## Instalación o actualización

### 1. Base de datos (Supabase)
1. **SQL Editor → New query**, pegá todo `supabase.sql` y **Run**. Tiene que decir "Success".
   - Si venías de la versión anterior: borra las tablas viejas (`remitos`, `movimientos_log`) pero **conserva los usuarios y sus roles**.
   - Se puede volver a correr sin perder datos.
2. Si tenías obras de prueba de la versión anterior, borralas corriendo el `delete` que está comentado al final de `supabase.sql`.

### 2. Usuarios
1. **Authentication → Users → Add user → Create new user**, con **Auto Confirm User** tildado.
2. Todos arrancan como **lector**. Para hacer admin a alguien, en el SQL Editor:
   ```sql
   update perfiles set rol = 'admin' where email = 'mail@ejemplo.com';
   ```
3. Cada usuario puede cambiar su contraseña desde la página (**Cambiar contraseña**).

### 3. Conectar la página
Pegá la **Project URL** y la clave **publishable/anon** en `config.js` (nunca la clave secret).

### 4. Publicar
Subí la carpeta a un repo **privado** de GitHub y conectalo a **Netlify** (sin build command, publish directory vacío). Cada `git push` publica la versión nueva; los datos viven en Supabase y no se tocan.

## Primer uso
1. Entrá como admin y creá las obras con **+ Obra**.
2. En **Depósito Central → Cargar lo que ya hay**, cargá todas las herramientas (con la cantidad de unidades de cada una) y los materiales.
3. Imprimí el listado o pegale a cada herramienta una etiqueta con su código.
4. A partir de ahí, cada envío a obra es un **Mover con remito**.
