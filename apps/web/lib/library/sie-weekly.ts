/**
 * Sichos In English "SIE Weekly": the weekly English translations of the Rebbe's Likkutei Sichos, with the Google Drive
 * file for each. Read ONCE from https://shop.sie.org/pages/weekly (the page SIE publishes for exactly this; the owner has
 * SIE's permission) on 2026-10-26 with a normal browser, and kept here as plain data. Printio never contacts sie.org
 * while running (their site refuses automated visitors); only the Drive files are fetched, through the safe link import.
 * To refresh after SIE adds new weeks: re-read that page and replace this list (see docs/ROADMAP.md).
 * Entries SIE marks "coming soon" (no file yet) are left out.
 */
export interface SieEntry {
  /** SIE's volume: "Alef", "Beis", "Gimmel", "Daled". */
  chelek: string;
  /** The book of the Torah: "Bereishis", "Shmos", "Vayikra", "Bamidbar", "Devarim". */
  sefer: string;
  /** The parsha or occasion: "Noach", "Yud Shvat". */
  title: string;
  /** The Google Drive file. */
  url: string;
  /** The Likkutei Sichos volume and starting page this translates, read from the first page of the file. Absent when it could not be read. */
  volume?: number;
  page?: number;
  /** The first page of the real content: SIE's files open with a cover, a blank page and one or two dedication pages. */
  from?: number;
  /** How many pages the file has. */
  pageCount?: number;
}

export const SIE_CREDIT = "Sichos In English (sie.org)";
export const SIE_SNAPSHOT_DATE = "2026-10-26";

export const SIE_WEEKLY: readonly SieEntry[] = [
  { chelek: "Alef", sefer: "Bereishis", title: "Bereishis", url: "https://drive.google.com/file/d/1I-mPynOpu1dMkcfo3LG49MYeXYh4whoo/view", volume: 1, page: 1, from: 4, pageCount: 18 },
  { chelek: "Alef", sefer: "Bereishis", title: "Noach", url: "https://drive.google.com/file/d/1CWNav1KEctok2nLBCgRWweEcWmNTC0ob/view", volume: 1, page: 4, from: 4, pageCount: 32 },
  { chelek: "Alef", sefer: "Bereishis", title: "Lech Lecha", url: "https://drive.google.com/file/d/10UPYgALr8xw4JhQj1pvOsw-lRhnn0CJ9/view", volume: 1, page: 15, from: 4, pageCount: 26 },
  { chelek: "Alef", sefer: "Bereishis", title: "Vayeira", url: "https://drive.google.com/file/d/10zfhtdYc6s9t7HrtFS9ZVW5dhxr6RcgE/view", volume: 1, page: 23, from: 4, pageCount: 24 },
  { chelek: "Alef", sefer: "Bereishis", title: "Chayei Sarah", url: "https://drive.google.com/file/d/16GQ1yrVv4X9soHekHtFjVDu3UTik0EN2/view", volume: 1, page: 31, from: 4, pageCount: 42 },
  { chelek: "Alef", sefer: "Bereishis", title: "Toldos", url: "https://drive.google.com/file/d/1FCvhMp9wYSpR1nmgwjnwO1ppPx0UgUsY/view", volume: 1, page: 45, from: 4, pageCount: 46 },
  { chelek: "Alef", sefer: "Bereishis", title: "Vayeitzei", url: "https://drive.google.com/file/d/1bj9jM9yCWxLLRV_6TmICb9jsUzQxtaaO/view", volume: 1, page: 60, from: 4, pageCount: 28 },
  { chelek: "Alef", sefer: "Bereishis", title: "Vayishlach", url: "https://drive.google.com/file/d/1a9z4mm7f3JwbHi3w15kO9fVH6C2g4h7d/view", volume: 1, page: 68, from: 4, pageCount: 30 },
  { chelek: "Alef", sefer: "Bereishis", title: "Vayeishev-Chanukah", url: "https://drive.google.com/file/d/1ItQrKu3H4fHF9KUdzu8GMRSnnZvYdBNH/view", volume: 1, page: 76, from: 4, pageCount: 28 },
  { chelek: "Alef", sefer: "Bereishis", title: "Mikeitz-Chanukah", url: "https://drive.google.com/file/d/1ZyrddctNrwHYkRdgtrg-RlMBlHmuBcDA/view", volume: 1, page: 85, from: 4, pageCount: 32 },
  { chelek: "Alef", sefer: "Bereishis", title: "Vayigash", url: "https://drive.google.com/file/d/1GSp_bCZiSiXAuIkArYjtPCq1_qxTw2p7/view", volume: 1, page: 94, from: 4, pageCount: 26 },
  { chelek: "Alef", sefer: "Bereishis", title: "Vayechi", url: "https://drive.google.com/file/d/1krla9aLa3qm3qNW30yT2V43ota7J23QT/view", volume: 1, page: 102, from: 4, pageCount: 28 },
  { chelek: "Alef", sefer: "Shmos", title: "Shmos", url: "https://drive.google.com/file/d/1Rzy4Rii-hh8t3qjquz_giD_yaIshnND1/view", volume: 1, page: 111, from: 4, pageCount: 30 },
  { chelek: "Alef", sefer: "Shmos", title: "Vaeira", url: "https://drive.google.com/file/d/1Rl1dPxSGNAxgG7EAEPtO1R7cTg1Si6AI/view", volume: 1, page: 119, from: 4, pageCount: 26 },
  { chelek: "Alef", sefer: "Shmos", title: "Bo", url: "https://drive.google.com/file/d/1LxV7i99bf6LmQIYJhQE_e5mkbytgsnCg/view", volume: 1, page: 127, from: 4, pageCount: 20 },
  { chelek: "Alef", sefer: "Shmos", title: "Yud Shvat", url: "https://drive.google.com/file/d/1b-4AJ4ClCzWVjmHASwv0kwCauHRs-tjh/view", volume: 1, page: 132, from: 4, pageCount: 24 },
  { chelek: "Alef", sefer: "Shmos", title: "Beshalach", url: "https://drive.google.com/file/d/1KNo-dCrRI_e_EjsgvwjDsNymt8xW-VmT/view", volume: 1, page: 139, from: 4, pageCount: 30 },
  { chelek: "Alef", sefer: "Shmos", title: "Yisro", url: "https://drive.google.com/file/d/1SnZ61-9KKhSzeNdSciVhW3CfJ0UFCAV5/view", volume: 1, page: 148, from: 4, pageCount: 26 },
  { chelek: "Alef", sefer: "Shmos", title: "Mishpatim", url: "https://drive.google.com/file/d/1Tq-qvT_iWTS4AhK13Tmtnju4kc3HKnYZ/view", volume: 1, page: 155, from: 4, pageCount: 28 },
  { chelek: "Alef", sefer: "Shmos", title: "Terumah", url: "https://drive.google.com/file/d/1Zz4dsc-J6n5Mppm9CVlLXKAVqQ9pQkrW/view", volume: 1, page: 162, from: 4, pageCount: 30 },
  { chelek: "Alef", sefer: "Shmos", title: "Tetzaveh", url: "https://drive.google.com/file/d/1jekSGkRsjefH9YEvESxvLT17U0S03DkD/view", volume: 1, page: 170, from: 4, pageCount: 30 },
  { chelek: "Alef", sefer: "Shmos", title: "Ki Sisa", url: "https://drive.google.com/file/d/1qsVE3m-WNKaL13a3gqCl5RByaK-ciHOa/view", volume: 1, page: 178, from: 4, pageCount: 28 },
  { chelek: "Alef", sefer: "Shmos", title: "Vayakhel", url: "https://drive.google.com/file/d/1d1z9RyA5UM44FkW0Agx3UuFaN6IuA4Nd/view", volume: 1, page: 187, from: 4, pageCount: 30 },
  { chelek: "Alef", sefer: "Shmos", title: "Pekudei", url: "https://drive.google.com/file/d/1Lr8DBy2Sj9xWzsnHIiNQkOb_8jIr1YXj/view", volume: 1, page: 195, from: 4, pageCount: 26 },
  { chelek: "Alef", sefer: "Vayikra", title: "Vayikra", url: "https://drive.google.com/file/d/1BVvg6G0Daba-qxrp69wkjsBs5LSvIH_M/view", volume: 1, page: 205, from: 4, pageCount: 16 },
  { chelek: "Alef", sefer: "Vayikra", title: "Purim", url: "https://drive.google.com/file/d/1TX0cj_dkv0b3mK83w2HCZfxubSFrM6nL/view", volume: 1, page: 213, from: 4, pageCount: 14 },
  { chelek: "Alef", sefer: "Vayikra", title: "Tzav", url: "https://drive.google.com/file/d/1DyF91DjycVHhpWBJwg_ZMpsjnTHVpNio/view", volume: 1, page: 217, from: 4, pageCount: 14 },
  { chelek: "Alef", sefer: "Vayikra", title: "4 Parshiyos", url: "https://drive.google.com/file/d/17quMhgCoLrEE2air3_1Jvl4co1hbIXQ-/view", volume: 1, page: 219, from: 4, pageCount: 14 },
  { chelek: "Alef", sefer: "Vayikra", title: "Shmini", url: "https://drive.google.com/file/d/1KPAoLTY_uOQOWoVCj9ZZgpueL2I9isKw/view", volume: 1, page: 222, from: 4, pageCount: 30 },
  { chelek: "Alef", sefer: "Vayikra", title: "Tazria", url: "https://drive.google.com/file/d/1pwlqtKeoM-QGRnxhqVRbTmsWytTnp6Oi/view", volume: 1, page: 231, from: 4, pageCount: 32 },
  { chelek: "Alef", sefer: "Vayikra", title: "Metzora", url: "https://drive.google.com/file/d/1MRgGqnRCbUzQqAcmFuMa8YOxFIHrpnWh/view", volume: 1, page: 239, from: 4, pageCount: 18 },
  { chelek: "Alef", sefer: "Vayikra", title: "Pesach", url: "https://drive.google.com/file/d/1qq__hlMRLdHBDl3zvSiJcjK9I-k_v6bb/view", volume: 1, page: 244, from: 4, pageCount: 32 },
  { chelek: "Alef", sefer: "Vayikra", title: "Acharei", url: "https://drive.google.com/file/d/1m67SL8GzbsvabqekJRQK8Nv4hrhXlRn3/view", volume: 1, page: 253, from: 4, pageCount: 10 },
  { chelek: "Alef", sefer: "Vayikra", title: "Kedoshim", url: "https://drive.google.com/file/d/1D00NTmxLKvs-r5Ehm7coHBxMRy1AXVv3/view", volume: 1, page: 254, from: 4, pageCount: 24 },
  { chelek: "Alef", sefer: "Vayikra", title: "Emor", url: "https://drive.google.com/file/d/1eMXb1szN0uDY3BhJAGnY8pJCu8LVl-Gt/view", volume: 1, page: 263, from: 4, pageCount: 30 },
  { chelek: "Alef", sefer: "Vayikra", title: "Behar", url: "https://drive.google.com/file/d/1eUAn3ipugbB31JWjsKyQ_Ngaf6MT6-Dj/view", volume: 1, page: 273, from: 4, pageCount: 30 },
  { chelek: "Alef", sefer: "Vayikra", title: "Bechukosai", url: "https://drive.google.com/file/d/1NWY2tm8zxWpFvh1keYPL1yES5ZRKw2_5/view", volume: 1, page: 281, from: 4, pageCount: 18 },
  { chelek: "Alef", sefer: "Vayikra", title: "Lag BaOmer", url: "https://drive.google.com/file/d/1EkFIZdGIOeh1JctxJBAgCcvra6CUMGyx/view", volume: 1, page: 285, from: 4, pageCount: 20 },
  { chelek: "Beis", sefer: "Bamidbar", title: "Bamidbar", url: "https://drive.google.com/file/d/1ov0v1Qy0nsdHna4vcaYSoA9rWJCycdXN/view", volume: 2, page: 293, from: 4, pageCount: 30 },
  { chelek: "Beis", sefer: "Bamidbar", title: "Nasso", url: "https://drive.google.com/file/d/13l-DXhXswsgVrSBUnZPfn1mVylvqJZWl/view", volume: 2, page: 311, from: 4, pageCount: 14 },
  { chelek: "Beis", sefer: "Bamidbar", title: "Beha'aloscha", url: "https://drive.google.com/file/d/1NqEOAUI8XJ73Hza0T_yjcoemNYtg9aJp/view", volume: 2, page: 314, from: 4, pageCount: 20 },
  { chelek: "Beis", sefer: "Bamidbar", title: "Shelach", url: "https://drive.google.com/file/d/1_e7J09DWa9AI0kGB68q3wz6LsX-TAYFo/view", volume: 2, page: 320, from: 4, pageCount: 20 },
  { chelek: "Beis", sefer: "Bamidbar", title: "Korach", url: "https://drive.google.com/file/d/1lKFGzYqj_o99Vao8m1iE5SNV5R23hVMr/view", volume: 2, page: 326, from: 4, pageCount: 20 },
  { chelek: "Beis", sefer: "Bamidbar", title: "Chukas", url: "https://drive.google.com/file/d/1kOIkYCcY46-PpOstwkkxTQkKCfpZcNk3/view", volume: 2, page: 331, from: 4, pageCount: 18 },
  { chelek: "Beis", sefer: "Bamidbar", title: "Balak", url: "https://drive.google.com/file/d/1AIlG8RWDeSbdoWo534e4WAMbWo_eKi-9/view", volume: 2, page: 337, from: 4, pageCount: 22 },
  { chelek: "Beis", sefer: "Bamidbar", title: "Pinchas", url: "https://drive.google.com/file/d/1skrMKscsCtz_THDQofvTM1n2FAoagtWq/view", volume: 2, page: 342, from: 4, pageCount: 22 },
  { chelek: "Beis", sefer: "Bamidbar", title: "Mattos - Maasei", url: "https://drive.google.com/file/d/13XsO7Aw5uudrAF3BLmF7HuMbgHhwU_eJ/view", volume: 2, page: 348, from: 4, pageCount: 20 },
  { chelek: "Beis", sefer: "Devarim", title: "Devarim", url: "https://drive.google.com/file/d/1iT2gXSoixdb0WpFaZPBomNUZtbYM5LIC/view", volume: 2, page: 357, from: 4, pageCount: 22 },
  { chelek: "Beis", sefer: "Devarim", title: "Va'eschanan", url: "https://drive.google.com/file/d/1HVC9JQnEVCJLiYpgDmATX2gkL5k3nzVO/view", volume: 2, page: 363, from: 4, pageCount: 24 },
  { chelek: "Beis", sefer: "Devarim", title: "Eikev", url: "https://drive.google.com/file/d/1g5YOHxKP2GPa4ihAMOrpzWmxaIWNlVLD/view", volume: 2, page: 371, from: 4, pageCount: 16 },
  { chelek: "Beis", sefer: "Devarim", title: "Re'eh", url: "https://drive.google.com/file/d/1l8nhOZaTWU9kHjyD7K9wm_95-qa4cHuM/view", volume: 2, page: 375, from: 4, pageCount: 20 },
  { chelek: "Beis", sefer: "Devarim", title: "Shoftim", url: "https://drive.google.com/file/d/1ijMYHu0oUWAk4prddUKO5rfg_aH3LSID/view", volume: 2, page: 380, from: 4, pageCount: 16 },
  { chelek: "Beis", sefer: "Devarim", title: "Ki Seitzei", url: "https://drive.google.com/file/d/1yujysDTDjsTCzAVilOJZrBx43u-GHC_F/view", volume: 2, page: 384, from: 4, pageCount: 26 },
  { chelek: "Beis", sefer: "Devarim", title: "Ki Savo", url: "https://drive.google.com/file/d/10fa1VZegbAts4s5gpNUuNDq187CG8VzC/view", volume: 2, page: 390, from: 4, pageCount: 30 },
  { chelek: "Beis", sefer: "Devarim", title: "Nitzavim", url: "https://drive.google.com/file/d/1L4vjoxjd0C0TJ1EUfP_tZ47FzUk6DrI5/view", volume: 2, page: 398, from: 4, pageCount: 26 },
  { chelek: "Beis", sefer: "Devarim", title: "Rosh Hashanah", url: "https://drive.google.com/file/d/1GvXEBUDRwOWauuI6tl5agqay5PMQEMWg/view", volume: 2, page: 405, from: 4, pageCount: 10 },
  { chelek: "Beis", sefer: "Devarim", title: "Vayeilech", url: "https://drive.google.com/file/d/1t0TNt30bI29Bs-TBuaXEd6XhnHbjbGeT/view", volume: 2, page: 407, from: 4, pageCount: 26 },
  { chelek: "Beis", sefer: "Devarim", title: "Ha'azinu", url: "https://drive.google.com/file/d/1lJezSb4ZlHCeL3zdPKQH6E8iJb68KYrk/view", volume: 2, page: 415, from: 4, pageCount: 14 },
  { chelek: "Beis", sefer: "Devarim", title: "Sukkos", url: "https://drive.google.com/file/d/1p7J3xOHa5DK4SxLS6QGpfILD7sIc59rW/view", volume: 2, page: 417, from: 4, pageCount: 50 },
  { chelek: "Beis", sefer: "Devarim", title: "Shemini Atzeres-Simchas Torah", url: "https://drive.google.com/file/d/1tlaz3iG4Gsd-bIakQWYlR7qX-_i00gOB/view", volume: 2, page: 433, from: 4, pageCount: 24 },
  { chelek: "Gimmel", sefer: "Bereishis", title: "Bereishis", url: "https://drive.google.com/file/d/18P6-qMG-t1GhTYCHNmpzgTdolZVQCFW5/view", volume: 3, page: 747, from: 5, pageCount: 14 },
  { chelek: "Gimmel", sefer: "Bereishis", title: "Noach", url: "https://drive.google.com/file/d/1QzULk5KamxPtFQF3IdLa9CxSzaWEUUZ5/view", volume: 3, page: 750, from: 5, pageCount: 22 },
  { chelek: "Gimmel", sefer: "Bereishis", title: "Lech Lecha", url: "https://drive.google.com/file/d/1HqbBVAs0OF_E2U40N2NuVpBzZsoKUHAJ/view", volume: 3, page: 757, from: 5, pageCount: 24 },
  { chelek: "Gimmel", sefer: "Bereishis", title: "Vayeira", url: "https://drive.google.com/file/d/1IN8K2djxXU0RNBwYFPDyS84kJmmXKRyX/view", volume: 3, page: 765, from: 5, pageCount: 24 },
  { chelek: "Gimmel", sefer: "Shmos", title: "Mishpatim", url: "https://drive.google.com/file/d/1bvJ8hC1r-TvspX8jJBVpty2i2-SlYul6/view", volume: 3, page: 895, from: 4, pageCount: 22 },
  { chelek: "Gimmel", sefer: "Shmos", title: "Terumah", url: "https://drive.google.com/file/d/1JGX-Jcf6XpjETE5DnnPdzVZxipsilLcG/view", volume: 3, page: 902, from: 4, pageCount: 26 },
  { chelek: "Gimmel", sefer: "Shmos", title: "Tetzaveh", url: "https://drive.google.com/file/d/1XQUfkoDzXCpEu3re6O6xxY9Tc7bF6dMs/view", volume: 3, page: 910, from: 4, pageCount: 14 },
  { chelek: "Gimmel", sefer: "Shmos", title: "Ki Sisa", url: "https://drive.google.com/file/d/1LH-tOlYWJrErJLGI_mT4kyLFjXw_zd64/view", volume: 3, page: 923, from: 4, pageCount: 22 },
  { chelek: "Gimmel", sefer: "Shmos", title: "Vayakhel - Adar", url: "https://drive.google.com/file/d/1B-FrN3cx50MEbYIu9qP-96NFcbkWAs9E/view", volume: 3, page: 930, from: 4, pageCount: 14 },
  { chelek: "Gimmel", sefer: "Shmos", title: "Pekudei", url: "https://drive.google.com/file/d/1NLQbzKuFxIzDOPEtYoB92uAMF2dPcNAD/view", volume: 3, page: 933, from: 4, pageCount: 18 },
  { chelek: "Gimmel", sefer: "Vayikra", title: "Vayikra", url: "https://drive.google.com/file/d/1Sfv7ttMcaR8caaqwCJXPuXf6yGfJfmOo/view", volume: 3, page: 939, from: 4, pageCount: 28 },
  { chelek: "Gimmel", sefer: "Vayikra", title: "Zachor", url: "https://drive.google.com/file/d/1Yo8laEtpnLdB8WeP14CYLpuaUHC_MW21/view", volume: 3, page: 913, from: 4, pageCount: 14 },
  { chelek: "Gimmel", sefer: "Vayikra", title: "Purim", url: "https://drive.google.com/file/d/1FaJbnnflPdYqzW8zUR5Im3ev_LcphAdn/view", volume: 3, page: 916, from: 4, pageCount: 20 },
  { chelek: "Gimmel", sefer: "Vayikra", title: "Tzav", url: "https://drive.google.com/file/d/1plEHmMqh11SFIBPg3RP_jZXeIjQve9Ld/view", volume: 3, page: 948, from: 4, pageCount: 18 },
  { chelek: "Gimmel", sefer: "Vayikra", title: "Shmini", url: "https://drive.google.com/file/d/1Dn6a_SlBlX8z20CHsYGgy4aus-Om9kaH/view", volume: 3, page: 973, from: 4, pageCount: 20 },
  { chelek: "Gimmel", sefer: "Vayikra", title: "Tazria", url: "https://drive.google.com/file/d/17mOHIiadKOb6_5HH-1QTJzd5jJCcXKth/view", volume: 3, page: 979, from: 4, pageCount: 16 },
  { chelek: "Gimmel", sefer: "Vayikra", title: "Metzora", url: "https://drive.google.com/file/d/1aRRSuR0rvOABLympQk_FkSIJGgLOgkpK/view", volume: 3, page: 983, from: 4, pageCount: 18 },
  { chelek: "Gimmel", sefer: "Vayikra", title: "Shabbos Hagadol", url: "https://drive.google.com/file/d/1v4GSB6oOTwxDXWjQer2NdKwFFX7QaD1k/view", volume: 3, page: 953, from: 4, pageCount: 16 },
  { chelek: "Gimmel", sefer: "Vayikra", title: "Pesach", url: "https://drive.google.com/file/d/168bxZ0MeuTcL9STr7-YFC-HhVgOMN0op/view", volume: 3, page: 957, from: 4, pageCount: 28 },
  { chelek: "Gimmel", sefer: "Vayikra", title: "Shevi'i Shel Pesach", url: "https://drive.google.com/file/d/1QYy-KI-Ytuk1dkYhW5z3qK_m3fJp8PAl/view", volume: 3, page: 966, from: 4, pageCount: 22 },
  { chelek: "Gimmel", sefer: "Vayikra", title: "Acharei", url: "https://drive.google.com/file/d/1kyJvtgyjTzfAIxBW0oWGqbsHUI_UGD4x/view", volume: 3, page: 987, from: 4, pageCount: 20 },
  { chelek: "Gimmel", sefer: "Vayikra", title: "Emor", url: "https://drive.google.com/file/d/1w4CVelvSDgAe8oR6Wd6fDIavqHFOslLI/view", volume: 3, page: 995, from: 4, pageCount: 20 },
  { chelek: "Gimmel", sefer: "Vayikra", title: "Behar", url: "https://drive.google.com/file/d/1Ay7bmobzdCNY5oqkxgqwQfE6d3mtVQD3/view", volume: 3, page: 1007, from: 4, pageCount: 18 },
  { chelek: "Gimmel", sefer: "Vayikra", title: "Bechukosai", url: "https://drive.google.com/file/d/1s8yizibvVpeYzLPmeoaHZ4BTCLI9N_Gj/view", volume: 3, page: 1012, from: 4, pageCount: 14 },
  { chelek: "Daled", sefer: "Bamidbar", title: "Bamidbar", url: "https://drive.google.com/file/d/1Ak1SpKaX4D8yGYR8IFnAxbZyg3X5DhAc/view", volume: 4, page: 1019, from: 4, pageCount: 18 },
  { chelek: "Daled", sefer: "Bamidbar", title: "Shavuos", url: "https://drive.google.com/file/d/1QOU3FcNXtNOqtS1bq5KAOEh0C8GjiYp9/view", volume: 4, page: 1024, from: 4, pageCount: 28 },
  { chelek: "Daled", sefer: "Bamidbar", title: "Nasso", url: "https://drive.google.com/file/d/1gtEd-yv_2L6Nf4Vnyi-jgZqDm67AYBYY/view", volume: 4, page: 1032, from: 4, pageCount: 12 },
  { chelek: "Daled", sefer: "Bamidbar", title: "Beha'aloscha", url: "https://drive.google.com/file/d/1-z3EZI6D3pwFpND3hr8abHTBYHX0ES98/view", volume: 4, page: 1035, from: 4, pageCount: 20 },
  { chelek: "Daled", sefer: "Bamidbar", title: "Shelach", url: "https://drive.google.com/file/d/1cSin9Djw4hJfgZoDcI8ZSVyHDGKwQtO_/view", volume: 4, page: 1041, from: 4, pageCount: 22 },
  { chelek: "Daled", sefer: "Bamidbar", title: "Korach", url: "https://drive.google.com/file/d/11wM5FmBpQ36zA4DtITMyShXcf7pExWxC/view", volume: 4, page: 1048, from: 4, pageCount: 26 },
  { chelek: "Daled", sefer: "Bamidbar", title: "Chukas", url: "https://drive.google.com/file/d/12jF5oqJnO1RFH81zQxkyH_r3PeoxfUnW/view", volume: 4, page: 1056, from: 4, pageCount: 20 },
  { chelek: "Daled", sefer: "Bamidbar", title: "12-13 Tammuz", url: "https://drive.google.com/file/d/17MT8oBo4d4utF1wdDPZtHbln8_LUfkuK/view", volume: 4, page: 1061, from: 4, pageCount: 20 },
  { chelek: "Daled", sefer: "Bamidbar", title: "Balak", url: "https://drive.google.com/file/d/1kw5JKgMIH7yX2pmaDr-f6sJp9bpNG9Hw/view", volume: 4, page: 1067, from: 4, pageCount: 14 },
  { chelek: "Daled", sefer: "Bamidbar", title: "Pinchas", url: "https://drive.google.com/file/d/1n-Lnz2jZw_kWq1PWo32f7eU2hVvPXqJm/view", volume: 4, page: 1070, from: 4, pageCount: 20 },
  { chelek: "Daled", sefer: "Bamidbar", title: "Mattos", url: "https://drive.google.com/file/d/1vtFTabIgJnrnMJ4iwOr82XthG0VjeuLw/view", volume: 4, page: 1076, from: 4, pageCount: 22 },
  { chelek: "Daled", sefer: "Bamidbar", title: "Maasei", url: "https://drive.google.com/file/d/1r9uHR-WCS8E7FcpnrmTunRsNr1CEPKLB/view", volume: 4, page: 1083, from: 4, pageCount: 10 },
  { chelek: "Daled", sefer: "Devarim", title: "Devarim", url: "https://drive.google.com/file/d/13RPkAlImUwH0syj2imYyQ_547cFB2MCN/view", volume: 4, page: 1087, from: 4, pageCount: 20 },
  { chelek: "Daled", sefer: "Devarim", title: "Va'eschanan", url: "https://drive.google.com/file/d/1j53mI72D-hP8_Ubon-RK9offuHqf9Cut/view", volume: 4, page: 1092, from: 4, pageCount: 22 },
  { chelek: "Daled", sefer: "Devarim", title: "Eikev", url: "https://drive.google.com/file/d/1S94El7Jxu9HnLPtBcnhqCoz82XWbeijR/view", volume: 4, page: 1098, from: 4, pageCount: 18 },
  { chelek: "Daled", sefer: "Devarim", title: "Re'eh", url: "https://drive.google.com/file/d/1Ym0upsINZlS9v0wMDW9u7ee7rw-kFc9-/view", volume: 4, page: 1108, from: 4, pageCount: 20 },
  { chelek: "Daled", sefer: "Devarim", title: "Shoftim", url: "https://drive.google.com/file/d/1Tz3DkEkE7foLaPXC-mF5la5bdmZaqVHB/view", volume: 4, page: 1114, from: 4, pageCount: 22 },
  { chelek: "Daled", sefer: "Devarim", title: "Ki Seitzei", url: "https://drive.google.com/file/d/1rDqfChhDnKQfxK8on4ZfJ061zeO2vjAb/view", volume: 4, page: 1121, from: 4, pageCount: 14 },
  { chelek: "Daled", sefer: "Devarim", title: "Ki Savo", url: "https://drive.google.com/file/d/13U5FZL9895FfWx-zumhwCGs8F-bb8sbi/view", volume: 4, page: 1130, from: 4, pageCount: 20 },
  { chelek: "Daled", sefer: "Devarim", title: "Chai Elul", url: "https://drive.google.com/file/d/1810pguyXTdSJdUwI039MCX4cS_68aHGU/view", volume: 4, page: 1136, from: 4, pageCount: 14 },
  { chelek: "Daled", sefer: "Devarim", title: "Nitzavim", url: "https://drive.google.com/file/d/1CVoIBAdzaAuuZsf2cOnh5k2gXwqYquky/view", volume: 4, page: 1139, from: 4, pageCount: 18 },
  { chelek: "Daled", sefer: "Devarim", title: "Rosh Hashanah", url: "https://drive.google.com/file/d/1MH8XFADVI29gm6SCzYq01GLBhABhDozQ/view", volume: 4, page: 1144, from: 4, pageCount: 18 },
  { chelek: "Daled", sefer: "Devarim", title: "Vayeilech", url: "https://drive.google.com/file/d/1o8fwJ1BTDxf2qRbffSXjBLLKKLthDrym/view", volume: 4, page: 1148, from: 4, pageCount: 10 },
  { chelek: "Daled", sefer: "Devarim", title: "Yom Kippur", url: "https://drive.google.com/file/d/1b37nQMZBCl6ofpuxaoPSJqsILmHTlmNl/view", volume: 4, page: 1149, from: 4, pageCount: 18 },
  { chelek: "Daled", sefer: "Devarim", title: "Ha'azinu", url: "https://drive.google.com/file/d/1x-l5PIRuXRSLpAaHrP301l0kiCz5FMDR/view", volume: 4, page: 1154, from: 4, pageCount: 18 },
  { chelek: "Daled", sefer: "Devarim", title: "Sukkos", url: "https://drive.google.com/file/d/1g-COw3phkO1hv3MEGTmZBpB0v7Eq_X-5/view", volume: 4, page: 1159, from: 4, pageCount: 22 },
  { chelek: "Daled", sefer: "Devarim", title: "Shemini Atzeres-Simchas Torah", url: "https://drive.google.com/file/d/1dBkFXNo4GyXXBtirfdKJvtpvdaijzwQs/view", volume: 4, page: 1165, from: 4, pageCount: 22 },
];
