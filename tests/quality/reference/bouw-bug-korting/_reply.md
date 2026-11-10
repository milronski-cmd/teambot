De fout zat in discountRate: daar stond `> 5` en `> 10`, terwijl de korting geldt vanaf 5 en vanaf 10 stuks. Ik heb het veranderd in `>= 5` en `>= 10`. Nu slagen alle tests.
