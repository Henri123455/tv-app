# TV voor iPhone (zonder pc)

De TV-app als echte iPhone-app. Hij praat rechtstreeks met je IPTV-aanbieder en speelt af in Apple's eigen speler: schermvullend, liggend, met AirPlay en beeld-in-beeld. Je pc hoeft niet aan te staan.

GitHub bouwt de app gratis op een Mac. Jij zet hem één keer op je iPhone met **SideStore** (met je eigen Apple ID). Daarna ververst SideStore hem op je telefoon zelf.

In deze code staat **geen** inlog. Je logt in de app zelf in.

---

## 1. Op GitHub zetten (eenmalig, ±10 minuten)

1. Maak een gratis account op [github.com](https://github.com).
2. Klik rechtsboven op **+** → **New repository**.
   - Naam: bijvoorbeeld `tv-app`
   - Kies **Public**. Dan bouwt GitHub de iPhone-app gratis, en kan de app de Netflix-cijfers lezen. Er staat geen inlog in.
   - Klik **Create repository**.
3. Klik op **uploading an existing file**.
4. Open op je pc de map `Downloads\tv-iphone-app`. Selecteer **alles wat erin staat** (ook de map `.github`) en sleep het naar de GitHub-pagina. Klik **Commit changes**.
5. Ga naar het tabblad **Actions**. Klik op **I understand my workflows, go ahead and enable them** als GitHub daarom vraagt.
6. Klik links op **Netflix Top 10 Nederland** → **Run workflow** (eenmalig; daarna gaat het elke ochtend vanzelf).
7. Klik links op **iPhone-app bouwen** → **Run workflow**. Na ongeveer 10 minuten staat er een groen vinkje.
8. Rechts op de hoofdpagina van je repo staat nu **Releases** met **TV.ipa**. Dat is je app.

## 2. SideStore op je iPhone (eenmalig met de pc)

SideStore zet apps die niet uit de App Store komen op je iPhone. Je gebruikt je eigen gratis Apple ID.

1. Volg de officiële uitleg op **[docs.sidestore.io](https://docs.sidestore.io)** ("Installation", Windows). Kort samengevat:
   - Installeer iTunes en iCloud via de website van Apple (niet via de Microsoft Store).
   - Sluit je iPhone met een kabel aan en tik op **Vertrouw**.
   - Installeer SideStore met het installatieprogramma uit de handleiding en log in met je Apple ID.
2. Op je iPhone:
   - Ga naar **Instellingen → Privacy en beveiliging → Ontwikkelaarsmodus** en zet die aan (je iPhone herstart).
   - Ga naar **Instellingen → Algemeen → VPN en apparaatbeheer** en vertrouw je Apple ID.
   - Installeer **LocalDevVPN** uit de App Store (zoals de handleiding zegt). Daarmee ververst SideStore zonder pc.

## 3. TV installeren

1. Open op je iPhone in Safari: `https://github.com/<jouw-naam>/tv-app/releases/latest/download/TV.ipa`
2. Tik op **Download**.
3. Open **SideStore** → **Mijn apps** → **+** → kies **TV.ipa**.
4. Open **TV**:
   - log in met je server, gebruikersnaam en wachtwoord (die van WhatsApp);
   - maak je profiel.

## 4. Elke 7 dagen

Een gratis Apple ID laat apps 7 dagen werken. Open SideStore en tik op **Alles vernieuwen**; dat gaat op je telefoon zelf, zonder pc. Een ontwikkelaarsaccount van Apple ($99 per jaar) maakt dat 1 jaar.

## Goed om te weten

- **Zenders en mp4-films** spelen in Apple's eigen speler, rechtstreeks van de aanbieder.
- **.mkv/.avi-films** kan Apple's speler niet afspelen. Die openen in de gratis app **VLC**, in volle kwaliteit en ook met AirPlay.
- **Een zender doet het niet?** Sluit de speler binnen een paar seconden; de app probeert dan vanzelf de volgende bron.
- **Maximaal 2 apparaten tegelijk.** Dat is de limiet van je abonnement.

## De app bijwerken

Na een wijziging in de pc-app:
1. Dubbelklik op `Downloads\tv-iphone-app\bijwerken.cmd` (maakt de map `www` opnieuw).
2. Upload de map `www` opnieuw op GitHub (**Add file → Upload files**).
3. GitHub bouwt dan vanzelf een nieuwe TV.ipa. Installeer die in SideStore over de oude heen; je lijsten en profielen blijven bewaard.
